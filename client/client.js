// lsp's runtime in JavaScript (decision 0042, docs/script/javascript.md): what lsp --js puts before a program. Its
// values: numbers (exact and real alike: what prints a real as one is the compiler's types), strings, #t and #f as
// booleans, '() as null, pairs, interned symbols and characters, vectors as arrays, maps as Maps. Vectors and maps
// are values: vector-set and map-set make new ones.
"use strict";

class Pair {
    constructor(car, cdr) { this.car = car; this.cdr = cdr; }
}
class Sym {
    constructor(name) { this.name = name; }
}
class Char {
    constructor(code) { this.code = code; }
}
const $symbols = new Map();
function $sym(name) {
    let s = $symbols.get(name);
    if (!s) { s = new Sym(name); $symbols.set(name, s); }
    return s;
}
// records (docs/script/language.md#records): a type's descriptor, id|name|fields|ancestors, the compiler's string
// constant (a field name, name:type, or name@bit:width with s or u for a bit field), read once; a record its type and
// its fields' values in order, a bit field's as the exact it holds
const $recordTypes = new Map();
function $recordType(descriptor) {
    let t = $recordTypes.get(descriptor);
    if (t) return t;
    const [id, name, fields, ancestors] = descriptor.split("|");
    t = { id, name, fields: [], values: [], ancestors: ancestors ? ancestors.split(" ").filter((a) => a) : [] };
    for (const token of (fields || "").split(" ").filter((f) => f)) {
        const at = token.indexOf("@");
        if (at >= 0) {
            const m = /^(\d+):(\d+)([su])$/.exec(token.slice(at + 1));
            t.fields.push({ name: token.slice(0, at), bit: Number(m[1]), width: Number(m[2]), signed: m[3] === "s" });
        } else {
            const colon = token.indexOf(":");
            t.fields.push({ name: colon >= 0 ? token.slice(0, colon) : token, type: colon >= 0 ? token.slice(colon + 1) : "" });
            t.values.push(t.fields.length - 1);
        }
    }
    $recordTypes.set(descriptor, t);
    return t;
}
class LRecord {
    constructor(type, fields) { this.type = type; this.fields = fields; }
}
function $recordIs(value, descriptor) {
    if (!(value instanceof LRecord)) return false;
    const id = descriptor.slice(0, 16);
    return value.type.id === id || value.type.ancestors.includes(id);
}
// a bit field's value: an exact that fits, never cut down
function $bits(field, value) {
    if (!Number.isInteger(value)) $trap("wrong type: a bit field takes an exact");
    const low = field.signed ? -(2 ** (field.width - 1)) : 0;
    const high = field.signed ? 2 ** (field.width - 1) - 1 : 2 ** field.width - 1;
    if (value < low || value > high) $trap("overflow: " + field.name + " takes " + field.width + " bits");
    return value;
}

class LspError extends Error {}

function $trap(why) { throw new LspError(why); }
// exact's trap, made once: the backend throws it from a statement of its own ahead of the one the exact is in, which
// V8 keeps fast in a loop where a call there (even one never made) costs it the loop's unboxed reals (#1073)
const $notInteger = new LspError("wrong type: not an integer");
function $pair(x) { return x instanceof Pair ? x : $trap("wrong type: not a pair"); }

function $list(...items) {
    let l = null;
    for (let i = items.length - 1; i >= 0; i--) l = new Pair(items[i], l);
    return l;
}
// (list a b c) as the VM makes it, its last argument first: given in reverse
function $listFromEnd(...items) {
    let l = null;
    for (const item of items) l = new Pair(item, l);
    return l;
}
function $toArray(l) {
    const out = [];
    for (; l instanceof Pair; l = l.cdr) out.push(l.car);
    return out;
}

// numbers as lsp writes them: a real always with a point (2.0), an exact as an integer
function $realText(x) {
    if (Number.isInteger(x) && Math.abs(x) < 1e21) return x.toFixed(1);
    return String(x);
}
function $numberText(x) { return String(x); }
// to digits places, as C's printf("%.*f") writes it: a tie (0.125 to 2) to the even digit
function $fixedText(x, digits) {
    const scaled = x * 10 ** digits;
    if (Number.isFinite(scaled) && Number.isInteger(scaled * 2) && !Number.isInteger(scaled)) {
        const down = Math.floor(scaled);
        const even = down % 2 === 0 ? down : down + 1;
        return (even / 10 ** digits).toFixed(digits);
    }
    return x.toFixed(digits);
}

let $out = "";
// in a page (decision 0061): what's written goes to the console, a line at a time, its bytes read as UTF-8; a line not
// yet ended waits for its end (or the program's)
function $flush(all) {
    let end = $out.lastIndexOf("\n");
    if (all && end < $out.length - 1) end = $out.length;
    if (end < 0) return;
    for (const line of $text($out.slice(0, end)).split("\n")) console.log(line);
    $out = $out.slice(end + ($out[end] === "\n" ? 1 : 0));
}

function $equal(a, b) {
    if (a === b) return true;
    if (a instanceof Pair && b instanceof Pair) return $equal(a.car, b.car) && $equal(a.cdr, b.cdr);
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => $equal(v, b[i]));
    if (a instanceof LRecord && b instanceof LRecord) {
        return a.type.id === b.type.id && a.fields.every((v, i) => $equal(v, b.fields[i]));
    }
    if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false;
        for (const [k, v] of a) if (!b.has(k) || !$equal(v, b.get(k))) return false;
        return true;
    }
    return false;
}

// the built-ins a program calls as values (passed to another procedure, say), by their lsp names; a call names them
// directly, or is written inline (js_backend.cpp's table says which)
const $B = {};
$B["equal?"] = $equal;
$B["quotient"] = (a, b) => b === 0 ? $trap("division by zero") : Math.trunc(a / b);
$B["remainder"] = (a, b) => b === 0 ? $trap("division by zero") : a % b;
$B["modulo"] = (a, b) => b === 0 ? $trap("division by zero") : ((a % b) + b) % b;
$B["floor"] = Math.floor;
$B["round"] = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
$B["exact"] = (x) => Number.isInteger(x) ? x : $trap("wrong type: not an integer");
$B["inexact"] = (x) => x;
$B["number?"] = (x) => typeof x === "number";
$B["cons"] = (a, b) => new Pair(a, b);
$B["car"] = (p) => $pair(p).car;
$B["cdr"] = (p) => $pair(p).cdr;
$B["pair?"] = (x) => x instanceof Pair;
$B["null?"] = (x) => x === null;
$B["length"] = (l) => $toArray(l).length;
$B["append"] = (...ls) => { const all = []; for (const l of ls) all.push(...$toArray(l)); return $list(...all); };
$B["reverse"] = (l) => $list(...$toArray(l).reverse());
$B["string?"] = (x) => typeof x === "string";
$B["string-append"] = (...s) => s.join("");
$B["string-length"] = (s) => s.length;
$B["substring"] = (s, a, b) => s.substring(a, b);
$B["string-prefix?"] = (p, s) => s.startsWith(p);
$B["string-suffix?"] = (p, s) => s.endsWith(p);
$B["number->string"] = (x, digits) => digits === undefined ? $numberText(x) : $fixedText(x, digits);
$B["string->number"] = (s) => { const n = Number(s); return s.trim() === "" || Number.isNaN(n) ? false : n; };
$B["byte-ref"] = (s, i) => { if (i < 0 || i >= s.length) $trap("index out of range"); return s.charCodeAt(i); };
$B["vector"] = (...a) => a;
$B["vector?"] = (x) => Array.isArray(x);
$B["vector-length"] = (v) => v.length;
$B["vector-ref"] = (v, i) => i >= 0 && i < v.length ? v[i] : $trap("index out of range");
$B["vector->list"] = (v) => $list(...v);
$B["map-of"] = (...kv) => { const m = new Map(); for (let i = 0; i + 1 < kv.length; i += 2) m.set(kv[i], kv[i + 1]); return m; };
$B["map?"] = (x) => x instanceof Map;
$B["map-ref"] = (m, k, d) => m.has(k) ? m.get(k) : (d === undefined ? $trap("no such key") : d);
$B["map-set"] = (m, k, v) => { const n = new Map(m); n.set(k, v); return n; };
$B["%record-register"] = (d) => { $recordType(d); };
$B["%record-make"] = (d, ...values) => {
    const t = $recordType(d);
    if (values.length !== t.fields.length) $trap("wrong type: " + t.name + " has " + t.fields.length + " fields");
    return new LRecord(t, values.map((v, i) => t.fields[i].bit === undefined ? v : $bits(t.fields[i], v)));
};
$B["%record-ref"] = (d, index, r) => {
    if (!$recordIs(r, d)) $trap("wrong type: not a " + $recordType(d).name);
    const field = r.type.values[index];
    return field === undefined ? $trap("index out of range") : r.fields[field];
};
$B["%record-is"] = (d, v) => $recordIs(v, d);
// lsp's strings are bytes, a JavaScript character each: Node's text is converted at the edges
const $bytes = (text) => { let s = ""; for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b); return s; };
const $text = (bytes) => new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
// JSON as lsp values: objects as maps with string keys, arrays as vectors, null as the symbol null
function $fromJson(j) {
    if (j === null) return $sym("null");
    if (Array.isArray(j)) return j.map($fromJson);
    if (typeof j === "object") { const m = new Map(); for (const k of Object.keys(j)) m.set(k, $fromJson(j[k])); return m; }
    return j;
}
function $toJson(v) {
    if (v instanceof Sym) return v.name === "null" ? null : v.name;
    if (v instanceof Map) { const o = {}; for (const [k, x] of v) o[k instanceof Sym ? k.name : String(k)] = $toJson(x); return o; }
    if (Array.isArray(v)) return v.map($toJson);
    if (v === null || v instanceof Pair) return $toArray(v).map($toJson);
    if (v instanceof Char) return String.fromCodePoint(v.code);
    return v;
}

$B["json-parse"] = (text, otherwise) => {
    try { return $fromJson(JSON.parse(text)); } catch (e) { return otherwise === undefined ? $trap("not JSON") : otherwise; }
};
$B["json-write"] = (value) => JSON.stringify($toJson(value));
$B["random-hex"] = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
// in a page: the program's setting up; what it set to happen later (events, timers) runs after. A runtime error is the
// console's, and the page goes on
function $run(program) {
    try {
        program();
    } catch (e) {
        $flush(true);
        if (e instanceof LspError) {
            console.error("runtime error: " + e.message);
            return;
        }
        throw e;
    }
    $flush(true);
}

// the build that wrote it (build-info)
const $build = { version: "0.3.2168+34cc1dfa.dirty", commit: "34cc1dfa", branch: "main" };

// the program
$run(() => {
  let add_class$21$27dom, address$27page, after$27page, again$27intro, alert$21$27page, append$21$27dom, as_queue$27remote, ask$27page, ask_where$27music, ask_where$27where, ask_which$27where, asked$27where, asked_href$27where, at_once$27photos, attribute_of$27dom, audio_close$21$27audio, audio_context$27audio, audio_now$27audio, audio_resume$21$27audio, audio_running$3f$27audio, back$21$27page, bar_key$27bar, bar_player$27bar, bar_wake$21$27bar, biquad$27audio, body$27dom, body_of$27dom, browser_id$27socket, by_id$27dom, cancel_timer$21$27page, capture_pointer$21$27dom, change$27dom, checked$3f$27dom, children_of$27dom, chime_notes$27intro, chimes$27intro, choices$27playlist, choose$27ui, chosen_files$27fetch, clamp$27picker, clear$21$27dom, clear_source$21$27media, click$27dom, clock$27clock, close$27dom, close_dialog$21$27dom, closest_of$27dom, confirmed$3f$27page, connect$21$27audio, connect$27socket, controls$27remote, converting_refreshes$27search, cookie_get$27page, cookie_set$21$27page, copy_content$21$27dom, data_of$27dom, default_prevented$3f$27dom, delay_node$27audio, destination$27audio, dialogs$3f$27dom, digits$3f$27bar, each_in$27picker, each_of$27intro, each_of$27photos, encode_component$27page, ended$27media, envelope$27intro, every$27page, fetch_text$27fetch, file_input_again$21$27fetch, file_name$27fetch, file_size$27fetch, film_back$27back, film_page$3f$27back, film_plays$27film, filters_apply$27search, first_element_of$27dom, focus$21$27dom, focus_window$21$27page, frame_step$27picker, full$3f$27keypad, fullscreen$21$27page, gain_node$27audio, go$21$27page, go$27bar, handlers$27socket, head_style$27page, heard$27socket, hidden$3f$27dom, hide$21$27remote, history_length$27page, id_of$27dom, import$21$27dom, input$27dom, insert_before$21$27dom, intro_plays$27intro, join_names$27player, kept$3f$27bar, key_of$27dom, keydown$27dom, keypads_work$27keypad, link_address$27page, load$27dom, loadedmetadata$27media, make_element$27dom, make_player$27player, make_player_options$27player, media_by_id$27media, media_duration$27media, media_in$27media, media_paused$3f$27media, media_ready$3f$27media, media_session$21$27media, media_time$27media, mousemove$27dom, music_buttons$27music, muted$3f$27media, new_playlist$27playlist, noise_source$27audio, note$27ui, nothing$27bar, now_ms$27page, nth$27saver, number_of$27picker, number_of_field$27film, on$27dom, on_document$27dom, on_media_key$27media, on_once$27dom, on_window$27page, only_able$27where, open_socket$27socket, open_window$27page, opener_session_get$27page, origin$27page, oscillator$27audio, other_screens$27where, page_title$27page, pagehide$27page, pages_swap$27bar, panner$27audio, param$27audio, part_in$27dom, partials$27intro, path$27page, pause$21$27media, pause$27media, pending$27playlist, photo_dialog$27photos, photos_page$27photos, picker_work$27picker, pickers_work$27picker, piece$27photos, place_pin$27photos, plain_click$3f$27dom, play$21$27media, play$27media, play_then$21$27media, play_where$27where, player$3f$27player, player_current$27player, player_link$3f$27where, player_media$27player, player_options$3f$27player, player_options_asleep$27player, player_options_bar$27player, player_options_film$27player, player_options_on_load$27player, player_options_on_sleep$27player, player_options_on_wake$27player, player_playing$3f$27player, player_position$27player, player_queue$27player, player_reload$27player, player_send$27player, player_sleep$27player, player_state$27player, player_wake$27player, players_start$27bar, playlists_add$27playlist, plays$27film, pointer_x$27dom, pointer_y$27dom, pointerdown$27dom, pointermove$27dom, pointerup$27dom, pop_out$27playlist, popstate$27page, post_form$21$27fetch, post_piece_watched$21$27fetch, prevent_default$21$27dom, previous_of$27dom, push_address$21$27page, query$27dom, query_all$27dom, query_all_in$27dom, query_has$3f$27page, query_in$27dom, query_with$27page, queue_now$27player, quiet_ms$27photos, ramp_to$21$27audio, random$27page, read_page$27page, ready_to_play$27ready, rect_of$27dom, referrer$27page, reload$21$27page, remote_controls$27remote, remove$21$27dom, remove_class$21$27dom, replace_address$21$27page, resize$27page, saver_runs$27saver, screen_of$27where, screen_plays$27ready, scroll_to_top$21$27page, search_as_typed$27search, search_now$27search, seek$21$27media, seeked$27media, self$27socket, send$27music, send_to$27where, sent$27where, session_get$27page, session_remove$21$27page, session_set$21$27page, set_at$21$27audio, set_attribute$21$27dom, set_class$21$27dom, set_field$21$27dom, set_hidden$21$27dom, set_muted$21$27media, set_page_style$21$27dom, set_page_title$21$27page, set_poster$21$27media, set_source$21$27media, set_style$21$27dom, set_text$21$27dom, set_title$21$27dom, set_value$21$27audio, set_volume$21$27media, show_modal$21$27dom, show_subtitles$21$27media, shown_ms$27saver, site_path$27bar, socket_address$27browser$2fsocket, socket_open$27browser$2fsocket, socket_send$21$27browser$2fsocket, sound$27intro, start$21$27audio, start_player$27player, stop$21$27audio, submit$27dom, submit_form$21$27dom, subtitles_showing$3f$27media, swappable$3f$27bar, tab$27socket, tab_id$27socket, tag_of$27dom, targets$27where, text$21$27ready, text$21$27remote, text_of$27dom, this_page$27dom, time_text$27picker, timeupdate$27media, toggle_class$21$27dom, touchstart$27dom, tries$27photos, user_agent$27page, value_of$27dom, volume$27media, volumechange$27media, wait$27socket, waiting$27where, with_pairs$27player, without$27saver;
  $sym("node");
  $sym("element");
  $sym("event");
  $sym("event-kind");
  (click$27dom = ("click"));
  (input$27dom = ("input"));
  (change$27dom = ("change"));
  (keydown$27dom = ("keydown"));
  (close$27dom = ("close"));
  (mousemove$27dom = ("mousemove"));
  (pointermove$27dom = ("pointermove"));
  (pointerup$27dom = ("pointerup"));
  (pointerdown$27dom = ("pointerdown"));
  (touchstart$27dom = ("touchstart"));
  (submit$27dom = ("submit"));
  (load$27dom = ("load"));
  (query$27dom = function (selector) {
    selector;
    return (document.querySelector($text(selector)) || false);
  });
  (by_id$27dom = function (id) {
    id;
    return (document.getElementById($text(id)) || false);
  });
  (query_all$27dom = function (selector) {
    selector;
    return (Array.from(document.querySelectorAll($text(selector))));
  });
  (query_in$27dom = function (n, selector) {
    n;
    selector;
    return ((n).querySelector($text(selector)) || false);
  });
  (set_title$21$27dom = function (e, text) {
    e;
    text;
    return ((e).title = $text(text));
  });
  (value_of$27dom = function (e) {
    e;
    return $bytes((e).value);
  });
  (focus$21$27dom = function (e) {
    e;
    return ((e).focus());
  });
  (set_field$21$27dom = function (e, value) {
    e;
    value;
    return ((e).value = $text(value));
  });
  (attribute_of$27dom = function (e, name) {
    e;
    name;
    return $bytes((e).getAttribute($text(name)) ?? "");
  });
  (set_attribute$21$27dom = function (e, name, value) {
    e;
    name;
    value;
    return ((e).setAttribute($text(name), $text(value)));
  });
  (clear$21$27dom = function (e) {
    e;
    return ((e).replaceChildren());
  });
  (data_of$27dom = function (e, name) {
    e;
    name;
    return $bytes((e).getAttribute("data-" + $text(name)) ?? "");
  });
  (copy_content$21$27dom = function (to, from) {
    to;
    from;
    return ((to).innerHTML = (from).innerHTML);
  });
  (part_in$27dom = function (n, selector, tag) {
    n;
    selector;
    tag;
    return ((n).querySelector($text(selector)) || document.createElement($text(tag)));
  });
  (query_all_in$27dom = function (n, selector) {
    n;
    selector;
    return (Array.from((n).querySelectorAll($text(selector))));
  });
  (children_of$27dom = function (e) {
    e;
    return (Array.from((e).children));
  });
  (first_element_of$27dom = function (n) {
    n;
    return ((n).firstElementChild || false);
  });
  (tag_of$27dom = function (e) {
    e;
    return $bytes((e).tagName);
  });
  (id_of$27dom = function (e) {
    e;
    return $bytes((e).id);
  });
  (hidden$3f$27dom = function (e) {
    e;
    return ((e).hidden);
  });
  (text_of$27dom = function (e) {
    e;
    return $bytes((e).textContent);
  });
  (previous_of$27dom = function (e) {
    e;
    return ((e).previousElementSibling || false);
  });
  (this_page$27dom = function () {
    return (document);
  });
  (body_of$27dom = function (n) {
    n;
    return ((n).body || false);
  });
  (import$21$27dom = function (e) {
    e;
    return (document.importNode((e), true));
  });
  (insert_before$21$27dom = function (parent, child, before) {
    parent;
    child;
    before;
    return ((parent).insertBefore((child), (before)));
  });
  (body$27dom = function () {
    return (document.body);
  });
  (make_element$27dom = function (tag) {
    tag;
    return (document.createElement($text(tag)));
  });
  (set_text$21$27dom = function (e, text) {
    e;
    text;
    return ((e).textContent = $text(text));
  });
  (set_class$21$27dom = function (e, name) {
    e;
    name;
    return ((e).className = $text(name));
  });
  (append$21$27dom = function (parent, child) {
    parent;
    child;
    return ((parent).appendChild((child)));
  });
  (remove$21$27dom = function (e) {
    e;
    return ((e).remove());
  });
  (show_modal$21$27dom = function (d) {
    d;
    return ((d).showModal());
  });
  (close_dialog$21$27dom = function (d) {
    d;
    return ((d).close());
  });
  (add_class$21$27dom = function (e, name) {
    e;
    name;
    return ((e).classList.add($text(name)));
  });
  (remove_class$21$27dom = function (e, name) {
    e;
    name;
    return ((e).classList.remove($text(name)));
  });
  (toggle_class$21$27dom = function (e, name, on$27dom) {
    e;
    name;
    on$27dom;
    return ((e).classList.toggle($text(name), (on$27dom)));
  });
  (set_style$21$27dom = function (e, name, value) {
    e;
    name;
    value;
    return ((e).style.setProperty($text(name), $text(value)));
  });
  (set_hidden$21$27dom = function (e, hidden) {
    e;
    hidden;
    return ((e).hidden = (hidden));
  });
  (checked$3f$27dom = function (e) {
    e;
    return ((e).checked === true);
  });
  (set_page_style$21$27dom = function (name, value) {
    name;
    value;
    return (document.documentElement.style.setProperty($text(name), $text(value)));
  });
  (submit_form$21$27dom = function (field) {
    field;
    return ((field).form.submit());
  });
  (on$27dom = function (e, kind, handler) {
    e;
    kind;
    handler;
    return ((e).addEventListener((kind), (handler)));
  });
  (on_once$27dom = function (e, kind, handler) {
    e;
    kind;
    handler;
    return ((e).addEventListener((kind), (handler), { once: true }));
  });
  (prevent_default$21$27dom = function (e) {
    e;
    return ((e).preventDefault());
  });
  (on_document$27dom = function (kind, handler) {
    kind;
    handler;
    return (document.addEventListener((kind), (handler)));
  });
  (closest_of$27dom = function (e, selector) {
    e;
    selector;
    return (((e).target && (e).target.closest && (e).target.closest($text(selector))) || false);
  });
  (default_prevented$3f$27dom = function (e) {
    e;
    return ((e).defaultPrevented);
  });
  (dialogs$3f$27dom = function () {
    return (!!window.HTMLDialogElement);
  });
  (key_of$27dom = function (e) {
    e;
    return $bytes((e).key || "");
  });
  (pointer_x$27dom = function (e) {
    e;
    return (((e).clientX || 0));
  });
  (pointer_y$27dom = function (e) {
    e;
    return (((e).clientY || 0));
  });
  (rect_of$27dom = function (e) {
    e;
    return ((() => { const b = (e).getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })());
  });
  (capture_pointer$21$27dom = function (e, ev) {
    e;
    ev;
    return ((e).setPointerCapture && (ev).pointerId !== undefined && (e).setPointerCapture((ev).pointerId));
  });
  (plain_click$3f$27dom = function (e) {
    e;
    return ((e).button === 0 && !(e).metaKey && !(e).ctrlKey && !(e).shiftKey && !(e).altKey);
  });
  (path$27page = function () {
    return $bytes(location.pathname);
  });
  (origin$27page = function () {
    return $bytes(location.origin);
  });
  (referrer$27page = function () {
    return $bytes(document.referrer);
  });
  (history_length$27page = function () {
    return (history.length);
  });
  (back$21$27page = function () {
    return (history.back());
  });
  (address$27page = function () {
    return $bytes(location.href);
  });
  (link_address$27page = function (a) {
    a;
    return $bytes(((a).target ? "" : new URL((a).getAttribute("href"), location.href).href));
  });
  (query_with$27page = function (name, value) {
    name;
    value;
    return $bytes((() => { const q = new URLSearchParams(location.search); q.set($text(name), $text(value)); return q.toString(); })());
  });
  (push_address$21$27page = function (url) {
    url;
    return (history.pushState({ swapped: true }, "", $text(url)));
  });
  (popstate$27page = ("popstate"));
  (resize$27page = ("resize"));
  (scroll_to_top$21$27page = function () {
    return (window.scrollTo(0, 0));
  });
  (page_title$27page = function (n) {
    n;
    return $bytes((n).title);
  });
  (set_page_title$21$27page = function (title) {
    title;
    return (document.title = $text(title));
  });
  (head_style$27page = function (n) {
    n;
    return ((n).head.querySelector("style") || false);
  });
  (fullscreen$21$27page = function () {
    return ((() => { if (document.documentElement.requestFullscreen) { document.documentElement.requestFullscreen().catch(() => {}); } })());
  });
  (replace_address$21$27page = function (url) {
    url;
    return (history.replaceState(null, "", $text(url)));
  });
  (reload$21$27page = function () {
    return (location.reload());
  });
  (confirmed$3f$27page = function (question) {
    question;
    return (window.confirm($text($text(question))));
  });
  (go$21$27page = function (url) {
    url;
    return (location.href = $text(url));
  });
  (alert$21$27page = function (words) {
    words;
    return (alert($text(words)));
  });
  (ask$27page = function (question, answer) {
    question;
    answer;
    return ((() => { const a = prompt($text(question), $text(answer)); return a === null ? false : $bytes(a); })());
  });
  $sym("window");
  (open_window$27page = function (url, name, features) {
    url;
    name;
    features;
    return (window.open($text(url), $text(name), $text(features)) || false);
  });
  (focus_window$21$27page = function (w) {
    w;
    return ((w).focus());
  });
  (after$27page = function (ms, then) {
    ms;
    then;
    return (setTimeout((then), (ms)));
  });
  (cancel_timer$21$27page = function (id) {
    id;
    return (clearTimeout((id)));
  });
  (every$27page = function (ms, then) {
    ms;
    then;
    return (setInterval((then), (ms)));
  });
  (pagehide$27page = ("pagehide"));
  (on_window$27page = function (kind, handler) {
    kind;
    handler;
    return (window.addEventListener((kind), (handler)));
  });
  (query_has$3f$27page = function (name) {
    name;
    return (new URLSearchParams(location.search).has($text(name)));
  });
  (session_get$27page = function (key) {
    key;
    return $bytes((() => { try { return sessionStorage.getItem($text(key)) || ""; } catch (e) { return ""; } })());
  });
  (session_set$21$27page = function (key, value) {
    key;
    value;
    return ((() => { try { sessionStorage.setItem($text(key), $text(value)); return true; } catch (e) { return false; } })());
  });
  (session_remove$21$27page = function (key) {
    key;
    return ((() => { try { sessionStorage.removeItem($text(key)); } catch (e) {} })());
  });
  (opener_session_get$27page = function (key) {
    key;
    return $bytes((() => { try { return (window.opener && window.opener.sessionStorage.getItem($text(key))) || ""; } catch (e) { return ""; } })());
  });
  (cookie_get$27page = function (name) {
    name;
    return $bytes((() => { const f = document.cookie.split(";").map((c) => c.trim()).find((c) => c.indexOf($text(name) + "=") === 0); return f ? f.slice($text(name).length + 1) : ""; })());
  });
  (cookie_set$21$27page = function (name, value, max_age) {
    name;
    value;
    max_age;
    return (document.cookie = $text(name) + "=" + $text(value) + "; max-age=" + (max_age) + "; path=/; SameSite=Lax");
  });
  (user_agent$27page = function () {
    return $bytes(navigator.userAgent);
  });
  (now_ms$27page = function () {
    return (Date.now());
  });
  (random$27page = function () {
    return (Math.random());
  });
  (encode_component$27page = function (text) {
    text;
    return $bytes(encodeURIComponent($text(text)));
  });
  (read_page$27page = function (html) {
    html;
    return (new DOMParser().parseFromString($text(html), "text/html"));
  });
  $sym("socket");
  (socket_address$27browser$2fsocket = function (path) {
    path;
    return $bytes((location.protocol === "https:" ? "wss://" : "ws://") + location.host + $text(path));
  });
  (socket_open$27browser$2fsocket = function (url, on_open, on_text, on_close) {
    url;
    on_open;
    on_text;
    on_close;
    return ((() => { if (!window.WebSocket) return false; const s = new WebSocket($text(url)); s.addEventListener("open", () => ((on_open))()); s.addEventListener("message", (e) => ((on_text))($bytes(String(e.data)))); s.addEventListener("close", () => ((on_close))()); return s; })());
  });
  (socket_send$21$27browser$2fsocket = function (s, text) {
    s;
    text;
    return ((s).readyState === WebSocket.OPEN ? ((s).send($text(text)), true) : false);
  });
  (tab_id$27socket = function () {
    let kept$271, made$272;
    (kept$271 = session_get$27page("reel-tab"));
    if ((($B["equal?"](kept$271, "") === false) ? ($B["equal?"](kept$271, opener_session_get$27page("reel-tab")) === false) : false)) {
      return kept$271;
    } else {
      (made$272 = $B["random-hex"](8));
      session_set$21$27page("reel-tab", made$272);
      return made$272;
    }
  });
  (tab$27socket = tab_id$27socket());
  (browser_id$27socket = function () {
    let kept$273, made$274;
    (kept$273 = cookie_get$27page("reel-browser"));
    if ($B["equal?"](kept$273, "")) {
      (made$274 = $B["random-hex"](16));
      cookie_set$21$27page("reel-browser", made$274, 315360000);
      return made$274;
    } else {
      return kept$273;
    }
  });
  (self$27socket = $B["map-of"]());
  (handlers$27socket = $B["map-of"]());
  (open_socket$27socket = false);
  (wait$27socket = 1000);
  (heard$27socket = function (text) {
    let each$276, msg$275;
    (msg$275 = $B["json-parse"](text, false));
    if ($B["map?"](msg$275)) {
      ($B["equal?"]($B["map-ref"](msg$275, "type", ""), "you") ? (set_page_style$21$27dom("--safe-w", $B["string-append"]($B["number->string"]($B["map-ref"](msg$275, "safe_w", 80)), "vw")), set_page_style$21$27dom("--safe-h", $B["string-append"]($B["number->string"]($B["map-ref"](msg$275, "safe_h", 90)), "vh")), (self$27socket = msg$275)) : false);
      (each$276 = function (l) {
        for (;;) {
          if ($B["null?"](l)) {
            return true;
          } else {
            $B["car"](l)(text, msg$275);
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      });
      return each$276($B["map-ref"](handlers$27socket, $B["map-ref"](msg$275, "type", ""), null));
    } else {
      return false;
    }
  });
  (connect$27socket = function () {
    return (open_socket$27socket = socket_open$27browser$2fsocket(socket_address$27browser$2fsocket("/socket"), function () {
      let msg$27i1;
      (wait$27socket = 1000);
      (msg$27i1 = $B["map-of"]("type", "hello", "id", browser_id$27socket(), "tab", tab$27socket, "screen", ((by_id$27dom("ready")) !== false ? true : false), "agent", user_agent$27page()));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i1));
      } else {
        return false;
      }
    }, heard$27socket, function () {
      (open_socket$27socket = false);
      after$27page(wait$27socket, connect$27socket);
      return (wait$27socket = (((wait$27socket * 2) > 30000) ? 30000 : (wait$27socket * 2)));
    }));
  });
  (film_page$3f$27back = function (p) {
    let digits$3f, rest$278;
    (digits$3f = function (s, i) {
      let b$277;
      for (;;) {
        if ((i === $B["string-length"](s))) {
          return (i > 0);
        } else {
          (b$277 = $B["byte-ref"](s, i));
          if ((b$277 >= 48)) {
            if ((b$277 <= 57)) {
              const $t0 = s;
              const $t1 = (i + 1);
              s = $t0;
              i = $t1;
              continue;
            } else {
              return false;
            }
          } else {
            return false;
          }
        }
      }
    });
    if ($B["string-prefix?"]("/film/", p)) {
      (rest$278 = $B["substring"](p, 6, $B["string-length"](p)));
      return digits$3f(($B["string-suffix?"]("/", rest$278) ? $B["substring"](rest$278, 0, ($B["string-length"](rest$278) - 1)) : rest$278), 0);
    } else {
      return false;
    }
  });
  (film_back$27back = function () {
    let brand$279;
    (brand$279 = query$27dom("[data-brand]"));
    if (((brand$279) !== false ? ((film_page$3f$27back(path$27page())) !== false ? ($B["string-prefix?"]($B["string-append"](origin$27page(), "/"), referrer$27page()) ? (history_length$27page() >= 2) : false) : false) : false)) {
      set_title$21$27dom(brand$279, "Back");
      return on$27dom(brand$279, click$27dom, function (e) {
        if (plain_click$3f$27dom(e)) {
          prevent_default$21$27dom(e);
          return back$21$27page();
        } else {
          return false;
        }
      });
    } else {
      return false;
    }
  });
  $sym("file");
  (fetch_text$27fetch = function (url, then) {
    url;
    then;
    return (fetch($text(url)).then((r) => r.text().then((t) => ((then))(r.status, $bytes(t))), () => ((then))(0, "")));
  });
  (chosen_files$27fetch = function (e) {
    e;
    return (Array.from((e).files || []));
  });
  (file_name$27fetch = function (f) {
    f;
    return $bytes($bytes((f).name));
  });
  (file_input_again$21$27fetch = function (e) {
    e;
    return ((() => { const n = (e).cloneNode(false); n.value = ""; (e).removeAttribute("id"); (e).hidden = true; (e).after(n); return n; })());
  });
  (file_size$27fetch = function (f) {
    f;
    return ((f).size);
  });
  (post_piece_watched$21$27fetch = function (url, f, start, end, quiet, progress, then) {
    url;
    f;
    start;
    end;
    quiet;
    progress;
    then;
    return ((() => { const x = new XMLHttpRequest(); let done = false, timer = 0;
      const finish = (s, t) => { if (!done) { done = true; clearTimeout(timer); ((then))(s, t); } };
      const watch = () => { clearTimeout(timer); timer = setTimeout(() => { finish(0, "timed out, readyState " + x.readyState); x.abort(); }, (quiet)); };
      x.open("POST", $text(url));
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.upload.onprogress = (e) => { watch(); ((progress))(e.loaded); };
      x.onload = () => finish(x.status, $bytes(x.responseText));
      x.onerror = () => finish(0, "network error, readyState " + x.readyState);
      x.onabort = () => finish(0, "aborted");
      (f).slice((start), (end)).arrayBuffer().then((b) => { watch(); x.send(b); },
      (e) => finish(-1, $bytes((e && e.name) || "unreadable"))); })());
  });
  (post_form$21$27fetch = function (url, fields) {
    url;
    fields;
    return (fetch($text(url), { method: "POST", body: $text(fields), keepalive: true, headers: { "Content-Type": "application/x-www-form-urlencoded" } }).catch(() => {}));
  });
  (search_now$27search = function (box) {
    let url$2710;
    (url$2710 = $B["string-append"]("/search?q=", encode_component$27page(value_of$27dom(box))));
    return fetch_text$27fetch(url$2710, function (status, html) {
      let main$2712, page$2711, style$2714, their_style$2715, theirs$2713;
      (page$2711 = read_page$27page(html));
      (main$2712 = query$27dom("main"));
      (theirs$2713 = query_in$27dom(page$2711, "main"));
      (style$2714 = query$27dom("style"));
      (their_style$2715 = query_in$27dom(page$2711, "style"));
      if ((((main$2712) !== false ? ((theirs$2713) !== false ? (status === 200) : false) : false)) !== false) {
        ((((style$2714) !== false ? their_style$2715 : false)) !== false ? copy_content$21$27dom(style$2714, their_style$2715) : false);
        copy_content$21$27dom(main$2712, theirs$2713);
        set_attribute$21$27dom(main$2712, "class", attribute_of$27dom(theirs$2713, "class"));
        replace_address$21$27page(url$2710);
        return focus$21$27dom(box);
      } else {
        return false;
      }
    });
  });
  (search_as_typed$27search = function () {
    let box$2716, typing$2717;
    (box$2716 = query$27dom("input[data-search]"));
    (typing$2717 = 0);
    if ((box$2716) !== false) {
      return on$27dom(box$2716, input$27dom, function (e) {
        cancel_timer$21$27page(typing$2717);
        return (typing$2717 = after$27page(250, function () {
          return search_now$27search(box$2716);
        }));
      });
    } else {
      return false;
    }
  });
  (filters_apply$27search = function () {
    let each$2719, filters$2718;
    (filters$2718 = query_all$27dom("[data-filter]"));
    (each$2719 = function (i) {
      let f$2720;
      if ((i < $B["vector-length"](filters$2718))) {
        (f$2720 = $B["vector-ref"](filters$2718, i));
        on$27dom(f$2720, change$27dom, function (e) {
          return submit_form$21$27dom(f$2720);
        });
        return each$2719((i + 1));
      } else {
        return false;
      }
    });
    return each$2719(0);
  });
  (converting_refreshes$27search = function () {
    let n$2722, refresh$2721;
    (refresh$2721 = query$27dom("[data-refresh]"));
    if ((refresh$2721) !== false) {
      return after$27page((1000 * ((n$2722 = $B["string->number"](data_of$27dom(refresh$2721, "refresh"))), ((n$2722) !== false ? $B["exact"](n$2722) : 30))), function () {
        return reload$21$27page();
      });
    } else {
      return false;
    }
  });
  $sym("audio-context");
  $sym("audio-node");
  $sym("audio-param");
  (audio_context$27audio = function () {
    return ((() => { const C = window.AudioContext || window.webkitAudioContext; return C ? new C() : false; })());
  });
  (audio_running$3f$27audio = function (c) {
    c;
    return ((c).state === "running");
  });
  (audio_resume$21$27audio = function (c, then) {
    c;
    then;
    return ((c).resume().then(() => ((then))(), () => ((then))()));
  });
  (audio_close$21$27audio = function (c) {
    c;
    return ((c).close().catch(() => {}));
  });
  (audio_now$27audio = function (c) {
    c;
    return ((c).currentTime);
  });
  (destination$27audio = function (c) {
    c;
    return ((c).destination);
  });
  (gain_node$27audio = function (c) {
    c;
    return ((c).createGain());
  });
  (oscillator$27audio = function (c, kind) {
    c;
    kind;
    return ((() => { const o = (c).createOscillator(); o.type = $text(kind); return o; })());
  });
  (biquad$27audio = function (c, kind) {
    c;
    kind;
    return ((() => { const f = (c).createBiquadFilter(); f.type = $text(kind); return f; })());
  });
  (delay_node$27audio = function (c, most) {
    c;
    most;
    return ((c).createDelay((most)));
  });
  (panner$27audio = function (c) {
    c;
    return ((c).createStereoPanner ? (c).createStereoPanner() : false);
  });
  (noise_source$27audio = function (c, seconds) {
    c;
    seconds;
    return ((() => { const b = (c).createBuffer(1, Math.floor((c).sampleRate * (seconds)), (c).sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = (c).createBufferSource(); s.buffer = b; return s; })());
  });
  (connect$21$27audio = function (from, to) {
    from;
    to;
    return ((from).connect((to)));
  });
  (param$27audio = function (n, name) {
    n;
    name;
    return ((n)[$text(name)]);
  });
  (set_value$21$27audio = function (p, value) {
    p;
    value;
    return ((p).value = (value));
  });
  (set_at$21$27audio = function (p, value, at) {
    p;
    value;
    at;
    return ((p).setValueAtTime((value), (at)));
  });
  (ramp_to$21$27audio = function (p, value, at) {
    p;
    value;
    at;
    return ((p).exponentialRampToValueAtTime((value), (at)));
  });
  (start$21$27audio = function (n, at) {
    n;
    at;
    return ((n).start((at)));
  });
  (stop$21$27audio = function (n, at) {
    n;
    at;
    return ((n).stop((at)));
  });
  (again$27intro = function () {
    return false;
  });
  (intro_plays$27intro = function () {
    let audio$2724, begin_playing$2729, gone$2726, intro$2723, leave$2727, or$27value$2734, or$27value$2735, or$27value$2736, show$2730, start$2728, started$2725;
    (intro$2723 = by_id$27dom("intro"));
    (audio$2724 = false);
    (started$2725 = false);
    (gone$2726 = false);
    (leave$2727 = function () {
      let done$2731;
      if (gone$2726) {
        return false;
      } else {
        (gone$2726 = true);
        add_class$21$27dom(intro$2723, "leaving");
        after$27page(600, function () {
          return set_hidden$21$27dom(intro$2723, true);
        });
        (done$2731 = audio$2724);
        if ((done$2731) !== false) {
          return after$27page(4000, function () {
            return audio_close$21$27audio(done$2731);
          });
        } else {
          return false;
        }
      }
    });
    (start$2728 = function () {
      if (started$2725) {
        return false;
      } else {
        (started$2725 = true);
        add_class$21$27dom(intro$2723, "playing");
        (((audio$2724) !== false ? audio_running$3f$27audio(audio$2724) : false) ? sound$27intro(audio$2724) : false);
        return after$27page(3700, leave$2727);
      }
    });
    (begin_playing$2729 = function () {
      if (((audio$2724) !== false ? (audio_running$3f$27audio(audio$2724) === false) : false)) {
        return audio_resume$21$27audio(audio$2724, start$2728);
      } else {
        return start$2728();
      }
    });
    (show$2730 = function (asked) {
      let or$27value$2732, or$27value$2733;
      (audio$2724 = audio_context$27audio());
      (started$2725 = false);
      (gone$2726 = false);
      remove_class$21$27dom(intro$2723, "leaving");
      remove_class$21$27dom(intro$2723, "playing");
      set_hidden$21$27dom(intro$2723, false);
      if ((((or$27value$2732 = asked), (or$27value$2732 ? or$27value$2732 : ((or$27value$2733 = (audio$2724 === false)), (or$27value$2733 ? or$27value$2733 : audio_running$3f$27audio(audio$2724)))))) !== false) {
        return begin_playing$2729();
      } else {
        return false;
      }
    });
    if ((intro$2723 === false)) {
      return false;
    } else {
      on$27dom(intro$2723, click$27dom, function (e) {
        if (started$2725) {
          return leave$2727();
        } else {
          return begin_playing$2729();
        }
      });
      on_document$27dom(keydown$27dom, function (e) {
        if (gone$2726) {
          return false;
        } else {
          if ($B["equal?"](key_of$27dom(e), "Escape")) {
            return leave$2727();
          } else {
            if ((started$2725 === false)) {
              return begin_playing$2729();
            } else {
              return false;
            }
          }
        }
      });
      (again$27intro = function () {
        return show$2730(true);
      });
      if ((((or$27value$2734 = by_id$27dom("player")), ((or$27value$2734) !== false ? or$27value$2734 : ((or$27value$2735 = by_id$27dom("ready")), ((or$27value$2735) !== false ? or$27value$2735 : ((or$27value$2736 = query$27dom("[data-profiles]")), ((or$27value$2736) !== false ? or$27value$2736 : query$27dom("[data-help]")))))))) !== false) {
        return false;
      } else {
        if ((($B["equal?"](session_get$27page("hazelflix-intro"), "") === false) ? (query_has$3f$27page("intro") === false) : false)) {
          return false;
        } else {
          if ((session_set$21$27page("hazelflix-intro", "1") === false)) {
            return false;
          } else {
            return show$2730(false);
          }
        }
      }
    }
  });
  (envelope$27intro = function (g, at, attack, peak, hold, release) {
    let p$2737;
    (p$2737 = param$27audio(g, "gain"));
    set_at$21$27audio(p$2737, 0.0001, 0.0);
    set_at$21$27audio(p$2737, 0.0001, at);
    ramp_to$21$27audio(p$2737, peak, (at + attack));
    set_at$21$27audio(p$2737, peak, (at + (attack + hold)));
    return ramp_to$21$27audio(p$2737, 0.0001, (at + (attack + (hold + release))));
  });
  (each_of$27intro = function (l, f) {
    for (;;) {
      if ($B["null?"](l)) {
        return true;
      } else {
        f($B["car"](l));
        const $t0 = $B["cdr"](l);
        const $t1 = f;
        l = $t0;
        f = $t1;
        continue;
      }
    }
  });
  (sound$27intro = function (c) {
    let at$2748, band$2746, echo$2740, feedback$2741, hg$2747, hiss$2745, note$2750, notes$2751, open$2749, out$2739, t0$2738, wet$2742;
    (t0$2738 = (audio_now$27audio(c) + 0.050000000000000003));
    (out$2739 = gain_node$27audio(c));
    (echo$2740 = delay_node$27audio(c, 1.0));
    (feedback$2741 = gain_node$27audio(c));
    (wet$2742 = gain_node$27audio(c));
    set_value$21$27audio(param$27audio(out$2739, "gain"), 0.69999999999999996);
    connect$21$27audio(out$2739, destination$27audio(c));
    set_value$21$27audio(param$27audio(echo$2740, "delayTime"), 0.27000000000000002);
    set_value$21$27audio(param$27audio(feedback$2741, "gain"), 0.32000000000000001);
    set_value$21$27audio(param$27audio(wet$2742, "gain"), 0.28000000000000003);
    connect$21$27audio(echo$2740, feedback$2741);
    connect$21$27audio(feedback$2741, echo$2740);
    connect$21$27audio(echo$2740, wet$2742);
    connect$21$27audio(wet$2742, destination$27audio(c));
    connect$21$27audio(out$2739, echo$2740);
    each_of$27intro(new Pair(49.0, new Pair(49.600000000000001, null)), function (f) {
      let g$2744, o$2743;
      (o$2743 = oscillator$27audio(c, "sine"));
      (g$2744 = gain_node$27audio(c));
      set_at$21$27audio(param$27audio(o$2743, "frequency"), f, t0$2738);
      ramp_to$21$27audio(param$27audio(o$2743, "frequency"), (f * 1.1200000000000001), (t0$2738 + 2.2999999999999998));
      envelope$27intro(g$2744, t0$2738, 1.6000000000000001, 0.32000000000000001, 0.59999999999999998, 1.6000000000000001);
      connect$21$27audio(o$2743, g$2744);
      connect$21$27audio(g$2744, out$2739);
      start$21$27audio(o$2743, t0$2738);
      return stop$21$27audio(o$2743, (t0$2738 + 4.2000000000000002));
    });
    ((hiss$2745 = noise_source$27audio(c, 2.0)), (band$2746 = biquad$27audio(c, "bandpass")), (hg$2747 = gain_node$27audio(c)), set_value$21$27audio(param$27audio(band$2746, "Q"), 6.0), set_at$21$27audio(param$27audio(band$2746, "frequency"), 700.0, (t0$2738 + 1.1000000000000001)), ramp_to$21$27audio(param$27audio(band$2746, "frequency"), 7000.0, (t0$2738 + 2.2999999999999998)), envelope$27intro(hg$2747, (t0$2738 + 1.1000000000000001), 0.69999999999999996, 0.089999999999999997, 0.29999999999999999, 0.5), connect$21$27audio(hiss$2745, band$2746), connect$21$27audio(band$2746, hg$2747), connect$21$27audio(hg$2747, out$2739), start$21$27audio(hiss$2745, (t0$2738 + 1.1000000000000001)), stop$21$27audio(hiss$2745, (t0$2738 + 3.1000000000000001)));
    (at$2748 = (t0$2738 + 2.2999999999999998));
    (open$2749 = biquad$27audio(c, "lowpass"));
    set_at$21$27audio(param$27audio(open$2749, "frequency"), 500.0, at$2748);
    ramp_to$21$27audio(param$27audio(open$2749, "frequency"), 3000.0, (at$2748 + 1.2));
    connect$21$27audio(open$2749, out$2739);
    (note$2750 = function (f, i) {
      return each_of$27intro(new Pair(-6.0, new Pair(6.0, null)), function (cents) {
        let g$2753, o$2752;
        (o$2752 = oscillator$27audio(c, "triangle"));
        (g$2753 = gain_node$27audio(c));
        set_value$21$27audio(param$27audio(o$2752, "frequency"), f);
        set_value$21$27audio(param$27audio(o$2752, "detune"), cents);
        envelope$27intro(g$2753, (at$2748 + (i * 0.02)), 0.40000000000000002, 0.040000000000000001, 0.59999999999999998, 2.3999999999999999);
        connect$21$27audio(o$2752, g$2753);
        connect$21$27audio(g$2753, open$2749);
        start$21$27audio(o$2752, at$2748);
        return stop$21$27audio(o$2752, (at$2748 + 3.6000000000000001));
      });
    });
    (notes$2751 = function (l, i) {
      for (;;) {
        if ($B["null?"](l)) {
          return true;
        } else {
          note$2750($B["car"](l), i);
          const $t0 = $B["cdr"](l);
          const $t1 = (i + 1.0);
          l = $t0;
          i = $t1;
          continue;
        }
      }
    });
    notes$2751(new Pair(110.0, new Pair(164.81, new Pair(220.0, new Pair(277.18000000000001, new Pair(329.63, null))))), 0.0);
    return chimes$27intro(c, out$2739, at$2748);
  });
  (chime_notes$27intro = $B["vector"](880.0, 987.76999999999998, 1108.73, 1318.51, 1479.98, 1760.0, 1975.53, 2217.46));
  (partials$27intro = new Pair(new Pair(1.0, new Pair(1.0, new Pair(3.2000000000000002, null))), new Pair(new Pair(2.7599999999999998, new Pair(0.41999999999999998, new Pair(1.8999999999999999, null))), new Pair(new Pair(5.4000000000000004, new Pair(0.20000000000000001, new Pair(1.1000000000000001, null))), new Pair(new Pair(8.9299999999999997, new Pair(0.089999999999999997, new Pair(0.59999999999999998, null))), null)))));
  (chimes$27intro = function (c, out, at) {
    let strike;
    (strike = function (i, when, gap, last) {
      let first$2754, n$2755, place$2757, strength$2756;
      if ((i < 11)) {
        (first$2754 = $B["exact"]($B["floor"]((random$27page() * 8))));
        (n$2755 = ((first$2754 === last) ? $B["modulo"]((first$2754 + (1 + $B["exact"]($B["floor"]((random$27page() * 3))))), 8) : first$2754));
        (strength$2756 = (0.074999999999999997 * ((1.0 - ($B["inexact"](i) / 14.0)) * (0.69999999999999996 + (random$27page() * 0.5)))));
        (place$2757 = panner$27audio(c));
        ((place$2757) !== false ? (set_value$21$27audio(param$27audio(place$2757, "pan"), ((random$27page() * 1.3999999999999999) - 0.69999999999999996)), connect$21$27audio(place$2757, out)) : false);
        each_of$27intro(partials$27intro, function (p) {
          return each_of$27intro(new Pair(-4.0, new Pair(4.0, null)), function (cents) {
            let g$2759, o$2758, ring$2760;
            (o$2758 = oscillator$27audio(c, "sine"));
            (g$2759 = gain_node$27audio(c));
            (ring$2760 = $B["car"]($B["cdr"]($B["cdr"](p))));
            set_value$21$27audio(param$27audio(o$2758, "frequency"), ($B["vector-ref"](chime_notes$27intro, n$2755) * $B["car"](p)));
            set_value$21$27audio(param$27audio(o$2758, "detune"), (cents + ((random$27page() * 4.0) - 2.0)));
            set_at$21$27audio(param$27audio(g$2759, "gain"), 0.0001, when);
            ramp_to$21$27audio(param$27audio(g$2759, "gain"), (strength$2756 * $B["car"]($B["cdr"](p))), (when + 0.0040000000000000001));
            ramp_to$21$27audio(param$27audio(g$2759, "gain"), 0.0001, (when + ring$2760));
            connect$21$27audio(o$2758, g$2759);
            connect$21$27audio(g$2759, ((place$2757) !== false ? place$2757 : out));
            start$21$27audio(o$2758, when);
            return stop$21$27audio(o$2758, (when + (ring$2760 + 0.050000000000000003)));
          });
        });
        return strike((i + 1), (when + (gap + (random$27page() * gap))), (gap * 1.22), n$2755);
      } else {
        return true;
      }
    });
    return strike(0, (at + 0.02), 0.070000000000000007, -1);
  });
  $sym("media");
  (media_by_id$27media = function (id) {
    id;
    return ((() => { const e = document.getElementById($text(id)); return e instanceof HTMLMediaElement ? e : false; })());
  });
  (media_in$27media = function (n, selector) {
    n;
    selector;
    return ((() => { const e = (n).querySelector($text(selector)); return e instanceof HTMLMediaElement ? e : document.createElement("video"); })());
  });
  (loadedmetadata$27media = ("loadedmetadata"));
  (pause$27media = ("pause"));
  (ended$27media = ("ended"));
  (timeupdate$27media = ("timeupdate"));
  (play$27media = ("play"));
  (volumechange$27media = ("volumechange"));
  (seeked$27media = ("seeked"));
  (media_time$27media = function (m) {
    m;
    return ((m).currentTime || 0);
  });
  (seek$21$27media = function (m, s) {
    m;
    s;
    return ((m).currentTime = (s));
  });
  (media_paused$3f$27media = function (m) {
    m;
    return ((m).paused);
  });
  (media_duration$27media = function (m) {
    m;
    return ((isFinite((m).duration) ? (m).duration : 0));
  });
  (set_source$21$27media = function (m, url) {
    m;
    url;
    return ((m).src = $text(url));
  });
  (play$21$27media = function (m) {
    m;
    return ((m).play().catch(() => {}));
  });
  (pause$21$27media = function (m) {
    m;
    return ((m).pause());
  });
  (clear_source$21$27media = function (m) {
    m;
    return ((m).removeAttribute("src"));
  });
  (play_then$21$27media = function (m, playing, refused) {
    m;
    playing;
    refused;
    return ((m).play().then(() => ((playing))(), () => ((refused))()));
  });
  (media_ready$3f$27media = function (m) {
    m;
    return ((m).readyState >= 2);
  });
  (volume$27media = function (m) {
    m;
    return ((m).volume);
  });
  (set_volume$21$27media = function (m, v) {
    m;
    v;
    return ((m).volume = Math.min(1, Math.max(0, (v))));
  });
  (muted$3f$27media = function (m) {
    m;
    return ((m).muted);
  });
  (set_muted$21$27media = function (m, on$27dom) {
    m;
    on$27dom;
    return ((m).muted = (on$27dom));
  });
  (set_poster$21$27media = function (m, url) {
    m;
    url;
    return ((m).poster = $text(url));
  });
  (subtitles_showing$3f$27media = function (m) {
    m;
    return (Array.prototype.some.call((m).textTracks, (t) => t.mode === "showing"));
  });
  (show_subtitles$21$27media = function (m, n) {
    m;
    n;
    return (Array.prototype.forEach.call((m).textTracks, (t, i) => { t.mode = i === (n) ? "showing" : "disabled"; }));
  });
  (media_session$21$27media = function (title, artist, album, art) {
    title;
    artist;
    album;
    art;
    return ((() => { if ("mediaSession" in navigator) { navigator.mediaSession.metadata = new MediaMetadata({ title: $text(title), artist: $text(artist), album: $text(album), artwork: $text(art) ? [{ src: $text(art), sizes: "500x500" }] : [] }); } })());
  });
  (on_media_key$27media = function (action, handler) {
    action;
    handler;
    return ((() => { if ("mediaSession" in navigator) { navigator.mediaSession.setActionHandler($text(action), () => ((handler))()); } })());
  });
  (clock$27clock = function (s) {
    let h$2762, m$2763, n$27i2, n$27i3, t$2761;
    (t$2761 = ((s > 0.0) ? $B["exact"]($B["floor"](s)) : 0));
    (h$2762 = $B["quotient"](t$2761, 3600));
    (m$2763 = $B["quotient"]($B["remainder"](t$2761, 3600), 60));
    return $B["string-append"](((h$2762 > 0) ? $B["string-append"]($B["number->string"](h$2762), ":", ((n$27i2 = m$2763), ((n$27i2 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i2)) : $B["number->string"](n$27i2)))) : $B["number->string"](m$2763)), ":", ((n$27i3 = $B["remainder"](t$2761, 60)), ((n$27i3 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i3)) : $B["number->string"](n$27i3))));
  });
  ($B["%record-register"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|"), (make_player_options$27player = function (asleep, bar, film, on_load, on_wake, on_sleep) {
    return $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", asleep, bar, film, on_load, on_wake, on_sleep);
  }), (player_options_asleep$27player = function (r) {
    return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 0, r);
  }), (player_options_bar$27player = function (r) {
    return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 1, r);
  }), (player_options_film$27player = function (r) {
    return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 2, r);
  }), (player_options_on_load$27player = function (r) {
    return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 3, r);
  }), (player_options_on_wake$27player = function (r) {
    return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 4, r);
  }), (player_options_on_sleep$27player = function (r) {
    return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 5, r);
  }), (player_options$3f$27player = function (v) {
    return $B["%record-is"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", v);
  }));
  ($B["%record-register"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|"), (make_player$27player = function (wake, sleep, send, position, current, playing$3f, queue, state, reload, media) {
    return $B["%record-make"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", wake, sleep, send, position, current, playing$3f, queue, state, reload, media);
  }), (player_wake$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r);
  }), (player_sleep$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r);
  }), (player_send$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r);
  }), (player_position$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r);
  }), (player_current$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 4, r);
  }), (player_playing$3f$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r);
  }), (player_queue$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r);
  }), (player_state$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r);
  }), (player_reload$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 8, r);
  }), (player_media$27player = function (r) {
    return $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 9, r);
  }), (player$3f$27player = function (v) {
    return $B["%record-is"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", v);
  }));
  (queue_now$27player = 0);
  (with_pairs$27player = function (m, l) {
    for (;;) {
      if ($B["null?"](l)) {
        return m;
      } else {
        const $t0 = $B["map-set"](m, $B["car"]($B["car"](l)), $B["cdr"]($B["car"](l)));
        const $t1 = $B["cdr"](l);
        m = $t0;
        l = $t1;
        continue;
      }
    }
  });
  (join_names$27player = function (l) {
    if ($B["null?"](l)) {
      return "";
    } else {
      if ($B["null?"]($B["cdr"](l))) {
        return $B["car"](l);
      } else {
        return $B["string-append"]($B["car"](l), ", ", join_names$27player($B["cdr"](l)));
      }
    }
  });
  (start_player$27player = function (root, options) {
    let art$2767, asleep$2779, bar$2780, current$2784, current$27i87, dragging$2776, expected$2785, film_of$2781, handler$27i65, handler$27i66, handler$27i68, handler$27i71, heard$2775, items$2782, labels$21$2787, list_items$2792, listed$2777, live$2778, load$27dom$2788, loaded$2773, media$2766, media$27i92, number_in$2796, offset$2774, play_or_not$2789, playing$3f$27i88, position$2786, position$27i86, queue$27i89, queues$21$2793, received$2772, reload$27i91, render$2790, row$21$2791, seek$2768, select$27143, send$2783, send$27i85, sleep$2795, sleep$27i84, start$2769, state$2771, state$27i90, volume$27media$27159, wake$2794, wake$27i83, wanted$2770, x$27i4;
    (media$2766 = media_in$27media(root, "[data-p=media]"));
    (art$2767 = part_in$27dom(root, $B["string-append"]("[data-p=", "art", "]"), "img"));
    (seek$2768 = part_in$27dom(root, $B["string-append"]("[data-p=", "seek", "]"), "input"));
    (start$2769 = part_in$27dom(root, $B["string-append"]("[data-p=", "start", "]"), "button"));
    (wanted$2770 = ((x$27i4 = $B["string->number"](data_of$27dom(root, "queue"))), $B["exact"]($B["floor"](($B["number?"](x$27i4) ? (x$27i4 + 0.0) : 0.0)))));
    (state$2771 = false);
    (received$2772 = 0.0);
    (loaded$2773 = 0);
    (offset$2774 = 0.0);
    (heard$2775 = false);
    (dragging$2776 = false);
    (listed$2777 = "");
    (live$2778 = false);
    (asleep$2779 = $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 0, options));
    (bar$2780 = $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 1, options));
    (asleep$2779 ? false : (queue_now$27player = wanted$2770));
    (film_of$2781 = function (item) {
      let kind$2764$27i5, or$27value$2765$27i6;
      if (((kind$2764$27i5 = $B["map-ref"](item, "kind", "")), ((or$27value$2765$27i6 = $B["equal?"](kind$2764$27i5, "film")), (or$27value$2765$27i6 ? or$27value$2765$27i6 : $B["equal?"](kind$2764$27i5, "episode"))))) {
        return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 2, options)(item);
      } else {
        return false;
      }
    });
    (items$2782 = function () {
      if ((state$2771) !== false) {
        return $B["map-ref"](state$2771, "items", $B["vector"]());
      } else {
        return $B["vector"]();
      }
    });
    (send$2783 = function (op, extra) {
      let msg$27i7;
      (msg$27i7 = with_pairs$27player($B["map-of"]("type", "queue", "op", op, "queue", ((state$2771) !== false ? $B["map-ref"](state$2771, "id", 0) : wanted$2770)), extra));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i7));
      } else {
        return false;
      }
    });
    (current$2784 = function () {
      if (($B["vector-length"](items$2782()) > 0)) {
        return $B["vector-ref"](items$2782(), $B["map-ref"](state$2771, "at", 0));
      } else {
        return false;
      }
    });
    (expected$2785 = function () {
      let x$27i8, x$27i9;
      return (((x$27i8 = $B["map-ref"](state$2771, "position", 0)), ($B["number?"](x$27i8) ? (x$27i8 + 0.0) : 0.0)) + (((x$27i9 = $B["map-ref"](state$2771, "paused", false)), ((x$27i9) !== false ? (((x$27i9 === $sym("null")) === false) ? (($B["equal?"](x$27i9, 0) === false) ? ($B["equal?"](x$27i9, "") === false) : false) : false) : false)) ? 0.0 : ((now_ms$27page() - received$2772) / 1000.0)));
    });
    (position$2786 = function () {
      return (offset$2774 + media_time$27media(media$2766));
    });
    (labels$21$2787 = function (item, artist_text, artist_href, album_text, album_href) {
      let album$2798, artist$2797, before$2799, x$27i10;
      set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "title", "]"), "span"), ((x$27i10 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i10) ? x$27i10 : ($B["number?"](x$27i10) ? $B["number->string"](x$27i10) : ""))));
      (artist$2797 = part_in$27dom(root, $B["string-append"]("[data-p=", "artist", "]"), "a"));
      (album$2798 = part_in$27dom(root, $B["string-append"]("[data-p=", "album", "]"), "a"));
      set_text$21$27dom(artist$2797, artist_text);
      set_attribute$21$27dom(artist$2797, "href", artist_href);
      set_text$21$27dom(album$2798, album_text);
      set_attribute$21$27dom(album$2798, "href", album_href);
      (before$2799 = previous_of$27dom(album$2798));
      if ((before$2799) !== false) {
        return set_hidden$21$27dom(before$2799, $B["equal?"](album_text, ""));
      } else {
        return false;
      }
    });
    (load$27dom$2788 = function (item) {
      let at$27101, e$27102, or$27value$27105, or$27value$27106, p$27100, pictured$27104, src$27103, x$27i11, x$27i12, x$27i13, x$27i14, x$27i15, x$27i16, x$27i17, x$27i18, x$27i19, x$27i20, x$27i21, x$27i22, x$27i23, x$27i24, x$27i25, x$27i26, x$27i27, x$27i28, x$27i29, x$27i30;
      (p$27100 = film_of$2781(item));
      (at$27101 = ((e$27102 = ((x$27i11 = expected$2785()), $B["exact"]($B["floor"](($B["number?"](x$27i11) ? (x$27i11 + 0.0) : 0.0))))), ((e$27102 > 0) ? e$27102 : 0)));
      (loaded$2773 = $B["map-ref"](item, "id", 0));
      (heard$2775 = false);
      ((p$27100) !== false ? ((live$2778 = (((x$27i12 = $B["map-ref"](p$27100, "ready", false)), ((x$27i12) !== false ? (((x$27i12 === $sym("null")) === false) ? (($B["equal?"](x$27i12, 0) === false) ? ($B["equal?"](x$27i12, "") === false) : false) : false) : false)) === false)), (offset$2774 = (live$2778 ? ((x$27i13 = at$27101), ($B["number?"](x$27i13) ? (x$27i13 + 0.0) : 0.0)) : 0.0)), set_source$21$27media(media$2766, (live$2778 ? $B["string-append"]("/live/", ((x$27i14 = $B["map-ref"](p$27100, "file", 0)), ($B["string?"](x$27i14) ? x$27i14 : ($B["number?"](x$27i14) ? $B["number->string"](x$27i14) : ""))), "?t=", $B["number->string"](at$27101), (((x$27i15 = $B["map-ref"](p$27100, "format", 0)), ((x$27i15) !== false ? (((x$27i15 === $sym("null")) === false) ? (($B["equal?"](x$27i15, 0) === false) ? ($B["equal?"](x$27i15, "") === false) : false) : false) : false)) ? $B["string-append"]("&format=", ((x$27i16 = $B["map-ref"](p$27100, "format", 0)), ($B["string?"](x$27i16) ? x$27i16 : ($B["number?"](x$27i16) ? $B["number->string"](x$27i16) : "")))) : "")) : ((x$27i17 = $B["map-ref"](p$27100, "source", "")), ($B["string?"](x$27i17) ? x$27i17 : ($B["number?"](x$27i17) ? $B["number->string"](x$27i17) : "")))))) : ((src$27103 = ((x$27i18 = $B["map-ref"](item, "src", "")), ($B["string?"](x$27i18) ? x$27i18 : ($B["number?"](x$27i18) ? $B["number->string"](x$27i18) : "")))), (live$2778 = ((x$27i19 = $B["map-ref"](item, "live", false)), ((x$27i19) !== false ? (((x$27i19 === $sym("null")) === false) ? (($B["equal?"](x$27i19, 0) === false) ? ($B["equal?"](x$27i19, "") === false) : false) : false) : false))), (offset$2774 = (live$2778 ? ((x$27i20 = at$27101), ($B["number?"](x$27i20) ? (x$27i20 + 0.0) : 0.0)) : 0.0)), set_source$21$27media(media$2766, (live$2778 ? $B["string-append"](src$27103, "?t=", $B["number->string"](at$27101)) : src$27103))));
      (((live$2778 === false) ? (at$27101 > 0) : false) ? on_once$27dom(media$2766, loadedmetadata$27media, function (e) {
        return seek$21$27media(media$2766, expected$2785());
      }) : false);
      ((pictured$27104 = ((or$27value$27105 = ((p$27100) !== false ? true : false)), (or$27value$27105 ? or$27value$27105 : $B["equal?"]($B["map-ref"](item, "kind", ""), "video")))), set_hidden$21$27dom(media$2766, ((or$27value$27106 = (pictured$27104 === false)), (or$27value$27106 ? or$27value$27106 : bar$2780))), set_hidden$21$27dom(art$2767, (pictured$27104 ? (bar$2780 === false) : false)));
      set_attribute$21$27dom(art$2767, "src", ((x$27i21 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i21) ? x$27i21 : ($B["number?"](x$27i21) ? $B["number->string"](x$27i21) : ""))));
      labels$21$2787(item, ((x$27i22 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i22) ? x$27i22 : ($B["number?"](x$27i22) ? $B["number->string"](x$27i22) : ""))), $B["string-append"]("/artist/", ((x$27i23 = $B["map-ref"](item, "artist_id", "")), ($B["string?"](x$27i23) ? x$27i23 : ($B["number?"](x$27i23) ? $B["number->string"](x$27i23) : "")))), ((x$27i24 = $B["map-ref"](item, "album", "")), ($B["string?"](x$27i24) ? x$27i24 : ($B["number?"](x$27i24) ? $B["number->string"](x$27i24) : ""))), (((x$27i25 = $B["map-ref"](item, "album_id", 0)), ((x$27i25) !== false ? (((x$27i25 === $sym("null")) === false) ? (($B["equal?"](x$27i25, 0) === false) ? ($B["equal?"](x$27i25, "") === false) : false) : false) : false)) ? $B["string-append"]("/album/", ((x$27i26 = $B["map-ref"](item, "album_id", 0)), ($B["string?"](x$27i26) ? x$27i26 : ($B["number?"](x$27i26) ? $B["number->string"](x$27i26) : "")))) : "#"));
      media_session$21$27media(((x$27i27 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i27) ? x$27i27 : ($B["number?"](x$27i27) ? $B["number->string"](x$27i27) : ""))), ((x$27i28 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i28) ? x$27i28 : ($B["number?"](x$27i28) ? $B["number->string"](x$27i28) : ""))), ((x$27i29 = $B["map-ref"](item, "album", "")), ($B["string?"](x$27i29) ? x$27i29 : ($B["number?"](x$27i29) ? $B["number->string"](x$27i29) : ""))), ((x$27i30 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i30) ? x$27i30 : ($B["number?"](x$27i30) ? $B["number->string"](x$27i30) : ""))));
      return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 3, options)(item, p$27100);
    });
    (play_or_not$2789 = function () {
      let x$27i31;
      if (((x$27i31 = $B["map-ref"](state$2771, "paused", false)), ((x$27i31) !== false ? (((x$27i31 === $sym("null")) === false) ? (($B["equal?"](x$27i31, 0) === false) ? ($B["equal?"](x$27i31, "") === false) : false) : false) : false))) {
        return pause$21$27media(media$2766);
      } else {
        return play_then$21$27media(media$2766, function () {
          return set_hidden$21$27dom(start$2769, true);
        }, function () {
          return set_hidden$21$27dom(start$2769, false);
        });
      }
    });
    (render$2790 = function () {
      let how$27116, item$27107, item$27i32, kind$2764$27i33, me$27111, n$27108, names$27112, off$27109, or$27value$2765$27i34, others$27113, players$27110, repeat$27115, shuffle$27114, title$27117, x$27i35, x$27i36, x$27i37, x$27i38, x$27i39, x$27i40, x$27i41, x$27i43, x$27i44, x$27i45, x$27i46;
      (item$27107 = current$2784());
      (n$27108 = $B["vector-length"](items$2782()));
      set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "count", "]"), "span"), ((n$27108 === 0) ? "" : ((n$27108 === 1) ? "1 item" : $B["string-append"]($B["number->string"](n$27108), " items"))));
      ((item$27107 === false) ? ((loaded$2773 = 0), pause$21$27media(media$2766), clear_source$21$27media(media$2766), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "title", "]"), "span"), "Nothing playing")) : ((((item$27i32 = item$27107), ((kind$2764$27i33 = $B["map-ref"](item$27i32, "kind", "")), ((or$27value$2765$27i34 = $B["equal?"](kind$2764$27i33, "film")), (or$27value$2765$27i34 ? or$27value$2765$27i34 : $B["equal?"](kind$2764$27i33, "episode"))))) ? (film_of$2781(item$27107) === false) : false) ? (($B["equal?"]($B["map-ref"](item$27107, "id", 0), loaded$2773) ? false : ((loaded$2773 = $B["map-ref"](item$27107, "id", 0)), pause$21$27media(media$2766), clear_source$21$27media(media$2766), set_hidden$21$27dom(media$2766, true), set_hidden$21$27dom(art$2767, false), set_attribute$21$27dom(art$2767, "src", ((x$27i35 = $B["map-ref"](item$27107, "art", "")), ($B["string?"](x$27i35) ? x$27i35 : ($B["number?"](x$27i35) ? $B["number->string"](x$27i35) : "")))), labels$21$2787(item$27107, ((x$27i36 = $B["map-ref"](item$27107, "label", "")), ($B["string?"](x$27i36) ? x$27i36 : ($B["number?"](x$27i36) ? $B["number->string"](x$27i36) : ""))), ((x$27i37 = $B["map-ref"](item$27107, "src", "")), ($B["string?"](x$27i37) ? x$27i37 : ($B["number?"](x$27i37) ? $B["number->string"](x$27i37) : ""))), "", "#"))), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(expected$2785())), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "length", "]"), "span"), clock$27clock(((x$27i38 = $B["map-ref"](item$27107, "duration", 0)), ($B["number?"](x$27i38) ? (x$27i38 + 0.0) : 0.0)))), (dragging$2776 ? false : (set_attribute$21$27dom(seek$2768, "max", $B["number->string"](((x$27i39 = $B["map-ref"](item$27107, "duration", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i39) ? (x$27i39 + 0.0) : 0.0)))))), set_field$21$27dom(seek$2768, $B["number->string"](((x$27i40 = expected$2785()), $B["exact"]($B["floor"](($B["number?"](x$27i40) ? (x$27i40 + 0.0) : 0.0))))))))) : (($B["equal?"]($B["map-ref"](item$27107, "id", 0), loaded$2773) === false) ? (load$27dom$2788(item$27107), play_or_not$2789()) : (play_or_not$2789(), ((off$27109 = (position$2786() - expected$2785())), (((((x$27i41 = $B["map-ref"](state$2771, "paused", false)), ((x$27i41) !== false ? (((x$27i41 === $sym("null")) === false) ? (($B["equal?"](x$27i41, 0) === false) ? ($B["equal?"](x$27i41, "") === false) : false) : false) : false)) === false) ? (media_ready$3f$27media(media$2766) ? (((off$27109 < 0.0) ? (0.0 - off$27109) : off$27109) > (live$2778 ? 3.0 : 1.0)) : false) : false) ? (live$2778 ? (load$27dom$2788(item$27107), play_or_not$2789()) : seek$21$27media(media$2766, expected$2785())) : false))))));
      ((players$27110 = $B["map-ref"](state$2771, "players", $B["vector"]())), (me$27111 = browser_id$27socket()), (names$27112 = function (i) {
        let x$27i42;
        for (;;) {
          if ((i >= $B["vector-length"](players$27110))) {
            return null;
          } else {
            if ($B["equal?"]($B["map-ref"]($B["vector-ref"](players$27110, i), "id", ""), me$27111)) {
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return $B["cons"](((x$27i42 = $B["map-ref"]($B["vector-ref"](players$27110, i), "name", "")), ($B["string?"](x$27i42) ? x$27i42 : ($B["number?"](x$27i42) ? $B["number->string"](x$27i42) : ""))), names$27112((i + 1)));
            }
          }
        }
      }), ((others$27113 = ($B["vector?"](players$27110) ? names$27112(0) : null)), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "note", "]"), "span"), ($B["null?"](others$27113) ? "" : $B["string-append"]("Also playing on: ", join_names$27player(others$27113))))));
      set_hidden$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "play", "]"), "button"), (((x$27i43 = $B["map-ref"](state$2771, "paused", false)), ((x$27i43) !== false ? (((x$27i43 === $sym("null")) === false) ? (($B["equal?"](x$27i43, 0) === false) ? ($B["equal?"](x$27i43, "") === false) : false) : false) : false)) === false));
      set_hidden$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "pause", "]"), "button"), ((x$27i44 = $B["map-ref"](state$2771, "paused", false)), ((x$27i44) !== false ? (((x$27i44 === $sym("null")) === false) ? (($B["equal?"](x$27i44, 0) === false) ? ($B["equal?"](x$27i44, "") === false) : false) : false) : false)));
      ((shuffle$27114 = query_in$27dom(root, "[data-player=shuffle]")), (repeat$27115 = query_in$27dom(root, "[data-player=repeat]")), (how$27116 = ((x$27i45 = $B["map-ref"](state$2771, "repeat", "off")), ($B["string?"](x$27i45) ? x$27i45 : ($B["number?"](x$27i45) ? $B["number->string"](x$27i45) : "")))), ((shuffle$27114) !== false ? toggle_class$21$27dom(shuffle$27114, "on", ((x$27i46 = $B["map-ref"](state$2771, "shuffle", false)), ((x$27i46) !== false ? (((x$27i46 === $sym("null")) === false) ? (($B["equal?"](x$27i46, 0) === false) ? ($B["equal?"](x$27i46, "") === false) : false) : false) : false))) : false), ((repeat$27115) !== false ? ((title$27117 = $B["string-append"]("Repeat: ", ($B["equal?"](how$27116, "one") ? "this one" : how$27116))), toggle_class$21$27dom(repeat$27115, "on", ($B["equal?"](how$27116, "off") === false)), set_title$21$27dom(repeat$27115, title$27117), set_attribute$21$27dom(repeat$27115, "aria-label", title$27117)) : false));
      return list_items$2792();
    });
    (row$21$2791 = function (box, item, i) {
      let a$27130, act$21$27125, acts$27122, art$27123, kind$27124, n$27128, pic$27129, row$27118, sub$27121, tile$27127, title$27120, words$27119, x$27i47, x$27i48, x$27i49, x$27i50, x$27i51, x$27i52, x$27i53, x$27i54;
      (row$27118 = make_element$27dom("div"));
      (words$27119 = make_element$27dom("div"));
      (title$27120 = make_element$27dom("div"));
      (sub$27121 = make_element$27dom("div"));
      (acts$27122 = make_element$27dom("div"));
      (art$27123 = ((x$27i47 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i47) ? x$27i47 : ($B["number?"](x$27i47) ? $B["number->string"](x$27i47) : ""))));
      (kind$27124 = $B["map-ref"](item, "kind", ""));
      (act$21$27125 = function (name, mark, label) {
        let b$27126;
        (b$27126 = make_element$27dom("button"));
        set_attribute$21$27dom(b$27126, "type", "button");
        set_attribute$21$27dom(b$27126, "data-act", name);
        set_text$21$27dom(b$27126, mark);
        set_title$21$27dom(b$27126, label);
        set_attribute$21$27dom(b$27126, "aria-label", label);
        return append$21$27dom(acts$27122, b$27126);
      });
      set_class$21$27dom(row$27118, ((i === $B["map-ref"](state$2771, "at", 0)) ? "queue-row now" : "queue-row"));
      set_attribute$21$27dom(row$27118, "data-item", ((x$27i48 = $B["map-ref"](item, "id", 0)), ($B["string?"](x$27i48) ? x$27i48 : ($B["number?"](x$27i48) ? $B["number->string"](x$27i48) : ""))));
      ($B["equal?"](art$27123, "") ? ((tile$27127 = make_element$27dom("div")), (n$27128 = (((x$27i49 = $B["map-ref"](item, "song", 0)), ((x$27i49) !== false ? (((x$27i49 === $sym("null")) === false) ? (($B["equal?"](x$27i49, 0) === false) ? ($B["equal?"](x$27i49, "") === false) : false) : false) : false)) ? ((x$27i50 = $B["map-ref"](item, "song", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i50) ? (x$27i50 + 0.0) : 0.0)))) : ((x$27i51 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i51) ? (x$27i51 + 0.0) : 0.0)))))), set_class$21$27dom(tile$27127, "queue-tile"), set_style$21$27dom(tile$27127, "background", $B["string-append"]("hsl(", $B["number->string"]($B["modulo"]((n$27128 * 47), 360)), ", 38%, 30%)")), append$21$27dom(row$27118, tile$27127)) : ((pic$27129 = make_element$27dom("img")), set_attribute$21$27dom(pic$27129, "src", art$27123), set_attribute$21$27dom(pic$27129, "alt", ""), set_attribute$21$27dom(pic$27129, "loading", "lazy"), append$21$27dom(row$27118, pic$27129)));
      set_style$21$27dom(words$27119, "min-width", "0");
      set_class$21$27dom(title$27120, "queue-title");
      set_text$21$27dom(title$27120, $B["string-append"](((x$27i52 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i52) ? x$27i52 : ($B["number?"](x$27i52) ? $B["number->string"](x$27i52) : ""))), ($B["equal?"](kind$27124, "video") ? "  (video)" : ($B["equal?"](kind$27124, "film") ? "  (film)" : ""))));
      set_class$21$27dom(sub$27121, "queue-sub");
      set_text$21$27dom(sub$27121, $B["string-append"](((a$27130 = ((x$27i53 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i53) ? x$27i53 : ($B["number?"](x$27i53) ? $B["number->string"](x$27i53) : "")))), ($B["equal?"](a$27130, "") ? "" : $B["string-append"](a$27130, " \xc2\xb7 "))), clock$27clock(((x$27i54 = $B["map-ref"](item, "duration", 0)), ($B["number?"](x$27i54) ? (x$27i54 + 0.0) : 0.0)))));
      append$21$27dom(words$27119, title$27120);
      append$21$27dom(words$27119, sub$27121);
      act$21$27125("up", "\xe2\x96\xb2", "Up");
      act$21$27125("down", "\xe2\x96\xbc", "Down");
      act$21$27125("remove", "\xe2\x9c\x95", "Remove");
      append$21$27dom(row$27118, words$27119);
      append$21$27dom(row$27118, acts$27122);
      return append$21$27dom(box, row$27118);
    });
    (list_items$2792 = function () {
      let all$27132, box$27131, each$27137, ids$27133, key$27134, or$27value$27135, p$27136, x$27i56;
      (box$27131 = query_in$27dom(root, "[data-p=items]"));
      (all$27132 = items$2782());
      (ids$27133 = function (i) {
        let x$27i55;
        if ((i >= $B["vector-length"](all$27132))) {
          return "";
        } else {
          return $B["string-append"](",", ((x$27i55 = $B["map-ref"]($B["vector-ref"](all$27132, i), "id", 0)), ($B["string?"](x$27i55) ? x$27i55 : ($B["number?"](x$27i55) ? $B["number->string"](x$27i55) : ""))), ids$27133((i + 1)));
        }
      });
      (key$27134 = $B["string-append"](((x$27i56 = $B["map-ref"](state$2771, "at", 0)), ($B["string?"](x$27i56) ? x$27i56 : ($B["number?"](x$27i56) ? $B["number->string"](x$27i56) : ""))), ":", ids$27133(0)));
      if (((or$27value$27135 = (box$27131 === false)), (or$27value$27135 ? or$27value$27135 : $B["equal?"](key$27134, listed$2777)))) {
        return false;
      } else {
        (listed$2777 = key$27134);
        clear$21$27dom(box$27131);
        if (($B["vector-length"](all$27132) === 0)) {
          (p$27136 = make_element$27dom("p"));
          set_style$21$27dom(p$27136, "color", "var(--muted, #888)");
          set_text$21$27dom(p$27136, "Empty. Play an album, an artist or a song from Music, or add one with +.");
          return append$21$27dom(box$27131, p$27136);
        } else {
          (each$27137 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](all$27132))) {
                row$21$2791(box$27131, $B["vector-ref"](all$27132, i), i);
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          });
          return each$27137(0);
        }
      }
    });
    (queues$21$2793 = function (l) {
      let each$27139, select$27138, x$27i60;
      (select$27138 = query_in$27dom(root, "[data-p=queue]"));
      if ((select$27138) !== false) {
        clear$21$27dom(select$27138);
        ((each$27139 = function (i) {
          let o$27141, q$27140, x$27i57, x$27i58, x$27i59;
          for (;;) {
            if ((i < $B["vector-length"](l))) {
              (q$27140 = $B["vector-ref"](l, i));
              (o$27141 = make_element$27dom("option"));
              set_attribute$21$27dom(o$27141, "value", ((x$27i57 = $B["map-ref"](q$27140, "id", 0)), ($B["string?"](x$27i57) ? x$27i57 : ($B["number?"](x$27i57) ? $B["number->string"](x$27i57) : ""))));
              set_text$21$27dom(o$27141, $B["string-append"](((x$27i58 = $B["map-ref"](q$27140, "name", "")), ($B["string?"](x$27i58) ? x$27i58 : ($B["number?"](x$27i58) ? $B["number->string"](x$27i58) : ""))), " (", ((x$27i59 = $B["map-ref"](q$27140, "n", 0)), ($B["string?"](x$27i59) ? x$27i59 : ($B["number?"](x$27i59) ? $B["number->string"](x$27i59) : ""))), ")"));
              append$21$27dom(select$27138, o$27141);
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return false;
            }
          }
        }), each$27139(0));
        if ((state$2771) !== false) {
          return set_field$21$27dom(select$27138, ((x$27i60 = $B["map-ref"](state$2771, "id", 0)), ($B["string?"](x$27i60) ? x$27i60 : ($B["number?"](x$27i60) ? $B["number->string"](x$27i60) : ""))));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    (wake$2794 = function (queue) {
      let msg$27i61;
      (asleep$2779 = false);
      (wanted$2770 = queue);
      (loaded$2773 = 0);
      (listed$2777 = "");
      $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 4, options)();
      (msg$27i61 = $B["map-of"]("type", "player", "queue", wanted$2770));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i61));
      } else {
        return false;
      }
    });
    (sleep$2795 = function () {
      let msg$27i62;
      (asleep$2779 = true);
      (state$2771 = false);
      (loaded$2773 = 0);
      pause$21$27media(media$2766);
      clear_source$21$27media(media$2766);
      $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 5, options)();
      (msg$27i62 = $B["map-of"]("type", "player", "stop", true));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i62));
      } else {
        return false;
      }
    });
    (number_in$2796 = function (e) {
      let x$27i63;
      (x$27i63 = $B["string->number"](value_of$27dom(e)));
      return $B["exact"]($B["floor"](($B["number?"](x$27i63) ? (x$27i63 + 0.0) : 0.0)));
    });
    ((handler$27i65 = function (text, m) {
      let msg$27i64;
      if (asleep$2779) {
        return false;
      } else {
        (msg$27i64 = $B["map-of"]("type", "player", "queue", wanted$2770));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i64));
        } else {
          return false;
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i65)))));
    ((handler$27i66 = function (text, m) {
      return queues$21$2793($B["map-ref"](m, "queues", $B["vector"]()));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queues", $B["append"]($B["map-ref"](handlers$27socket, "queues", null), $listFromEnd(handler$27i66)))));
    ((handler$27i68 = function (text, m) {
      let or$27value$27142, x$27i67;
      if ((((or$27value$27142 = asleep$2779), (or$27value$27142 ? or$27value$27142 : ((wanted$2770 > 0) ? ($B["equal?"]($B["map-ref"](m, "id", 0), wanted$2770) === false) : false)))) !== false) {
        return false;
      } else {
        (wanted$2770 = ((x$27i67 = $B["map-ref"](m, "id", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i67) ? (x$27i67 + 0.0) : 0.0)))));
        (queue_now$27player = wanted$2770);
        (state$2771 = m);
        (received$2772 = now_ms$27page());
        set_field$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "queue", "]"), "select"), $B["number->string"](wanted$2770));
        ((($B["equal?"](path$27page(), "/music/player") ? (bar$2780 === false) : false)) !== false ? replace_address$21$27page($B["string-append"]("/music/player?", query_with$27page("queue", $B["number->string"](wanted$2770)))) : false);
        return render$2790();
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue", $B["append"]($B["map-ref"](handlers$27socket, "queue", null), $listFromEnd(handler$27i68)))));
    ((handler$27i71 = function (text, m) {
      let msg$27i70, x$27i69;
      if (asleep$2779) {
        return false;
      } else {
        (wanted$2770 = ((x$27i69 = $B["map-ref"](m, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i69) ? (x$27i69 + 0.0) : 0.0)))));
        (msg$27i70 = $B["map-of"]("type", "player", "queue", wanted$2770));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i70));
        } else {
          return false;
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue-made", $B["append"]($B["map-ref"](handlers$27socket, "queue-made", null), $listFromEnd(handler$27i71)))));
    ((select$27143 = part_in$27dom(root, $B["string-append"]("[data-p=", "queue", "]"), "select")), on$27dom(select$27143, change$27dom, function (e) {
      let msg$27i72;
      (wanted$2770 = number_in$2796(select$27143));
      (loaded$2773 = 0);
      (msg$27i72 = $B["map-of"]("type", "player", "queue", wanted$2770));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i72));
      } else {
        return false;
      }
    }));
    on$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "new", "]"), "button"), click$27dom, function (e) {
      let msg$27i73, name$27144;
      (name$27144 = ask$27page("The new queue's name", ""));
      if ((name$27144) !== false) {
        (msg$27i73 = $B["map-of"]("type", "queue", "op", "new", "name", name$27144));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i73));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    on$27dom(root, click$27dom, function (e) {
      let act$27149, all$27150, button$27148, control$27145, find$27152, item$27147, place$27151, row$27146, x$27i74;
      (control$27145 = closest_of$27dom(e, "[data-player]"));
      if ((control$27145) !== false) {
        return send$2783(data_of$27dom(control$27145, "player"), null);
      } else {
        (row$27146 = closest_of$27dom(e, ".queue-row"));
        if ((((row$27146) !== false ? state$2771 : false)) !== false) {
          (item$27147 = ((x$27i74 = $B["string->number"](data_of$27dom(row$27146, "item"))), $B["exact"]($B["floor"](($B["number?"](x$27i74) ? (x$27i74 + 0.0) : 0.0)))));
          (button$27148 = closest_of$27dom(e, "[data-act]"));
          (act$27149 = ((button$27148) !== false ? data_of$27dom(button$27148, "act") : ""));
          (all$27150 = items$2782());
          (place$27151 = ((find$27152 = function (i) {
            for (;;) {
              if ((i >= $B["vector-length"](all$27150))) {
                return -1;
              } else {
                if ($B["equal?"]($B["map-ref"]($B["vector-ref"](all$27150, i), "id", 0), item$27147)) {
                  return i;
                } else {
                  const $t0 = (i + 1);
                  i = $t0;
                  continue;
                }
              }
            }
          }), find$27152(0)));
          if ($B["equal?"](act$27149, "remove")) {
            return send$2783("remove", $listFromEnd($B["cons"]("item", item$27147)));
          } else {
            if (($B["equal?"](act$27149, "up") ? (place$27151 > 0) : false)) {
              return send$2783("move", $listFromEnd($B["cons"]("to", (place$27151 - 1)), $B["cons"]("item", item$27147)));
            } else {
              if (($B["equal?"](act$27149, "down") ? (place$27151 < ($B["vector-length"](all$27150) - 1)) : false)) {
                return send$2783("move", $listFromEnd($B["cons"]("to", (place$27151 + 1)), $B["cons"]("item", item$27147)));
              } else {
                if ($B["equal?"](act$27149, "")) {
                  return send$2783("jump", $listFromEnd($B["cons"]("item", item$27147)));
                } else {
                  return false;
                }
              }
            }
          }
        } else {
          return false;
        }
      }
    });
    on$27dom(start$2769, click$27dom, function (e) {
      return play_then$21$27media(media$2766, function () {
        return set_hidden$21$27dom(start$2769, true);
      }, function () {
        return false;
      });
    });
    on$27dom(media$2766, ended$27media, function (e) {
      let item$27153;
      (item$27153 = current$2784());
      if ((((item$27153) !== false ? (asleep$2779 === false) : false)) !== false) {
        return send$2783("ended", $listFromEnd($B["cons"]("item", $B["map-ref"](item$27153, "id", 0))));
      } else {
        return false;
      }
    });
    on$27dom(media$2766, timeupdate$27media, function (e) {
      let at$27155, d$27158, half$27157, item$27154, length$27156, x$27i75, x$27i76, x$27i77, x$27i78, x$27i79;
      (item$27154 = current$2784());
      if ((((item$27154) !== false ? (asleep$2779 === false) : false)) !== false) {
        (at$27155 = position$2786());
        (length$27156 = ((d$27158 = ((x$27i75 = $B["map-ref"](item$27154, "duration", 0)), ($B["number?"](x$27i75) ? (x$27i75 + 0.0) : 0.0))), ((d$27158 > 0.0) ? d$27158 : media_duration$27media(media$2766))));
        (half$27157 = (length$27156 / 2.0));
        (((heard$2775 === false) ? (((x$27i76 = $B["map-ref"](item$27154, "song", 0)), ((x$27i76) !== false ? (((x$27i76 === $sym("null")) === false) ? (($B["equal?"](x$27i76, 0) === false) ? ($B["equal?"](x$27i76, "") === false) : false) : false) : false)) ? (at$27155 > ((half$27157 < 240.0) ? half$27157 : 240.0)) : false) : false) ? ((heard$2775 = true), send$2783("heard", $listFromEnd($B["cons"]("song", $B["map-ref"](item$27154, "song", 0))))) : false);
        (dragging$2776 ? false : (set_attribute$21$27dom(seek$2768, "max", $B["number->string"](((x$27i77 = length$27156), $B["exact"]($B["floor"](($B["number?"](x$27i77) ? (x$27i77 + 0.0) : 0.0)))))), set_field$21$27dom(seek$2768, $B["number->string"](((x$27i78 = at$27155), $B["exact"]($B["floor"](($B["number?"](x$27i78) ? (x$27i78 + 0.0) : 0.0))))))));
        set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock((dragging$2776 ? ((x$27i79 = number_in$2796(seek$2768)), ($B["number?"](x$27i79) ? (x$27i79 + 0.0) : 0.0)) : at$27155)));
        return set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "length", "]"), "span"), clock$27clock(length$27156));
      } else {
        return false;
      }
    });
    on$27dom(seek$2768, input$27dom, function (e) {
      let x$27i80;
      (dragging$2776 = true);
      return set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(((x$27i80 = number_in$2796(seek$2768)), ($B["number?"](x$27i80) ? (x$27i80 + 0.0) : 0.0))));
    });
    on$27dom(seek$2768, change$27dom, function (e) {
      (dragging$2776 = false);
      return send$2783("seek", $listFromEnd($B["cons"]("value", number_in$2796(seek$2768))));
    });
    ((volume$27media$27159 = part_in$27dom(root, $B["string-append"]("[data-p=", "volume", "]"), "input")), on$27dom(volume$27media$27159, input$27dom, function (e) {
      let x$27i81;
      return set_volume$21$27media(media$2766, (((x$27i81 = number_in$2796(volume$27media$27159)), ($B["number?"](x$27i81) ? (x$27i81 + 0.0) : 0.0)) / 100.0));
    }));
    on_media_key$27media("play", function () {
      if (asleep$2779) {
        return false;
      } else {
        return send$2783("toggle", null);
      }
    });
    on_media_key$27media("pause", function () {
      if (asleep$2779) {
        return false;
      } else {
        return send$2783("toggle", null);
      }
    });
    on_media_key$27media("nexttrack", function () {
      if (asleep$2779) {
        return false;
      } else {
        return send$2783("next", null);
      }
    });
    on_media_key$27media("previoustrack", function () {
      if (asleep$2779) {
        return false;
      } else {
        return send$2783("prev", null);
      }
    });
    every$27page(2000, function () {
      let x$27i82;
      if ((((asleep$2779 === false) ? ((state$2771) !== false ? ((((x$27i82 = $B["map-ref"](state$2771, "paused", false)), ((x$27i82) !== false ? (((x$27i82 === $sym("null")) === false) ? (($B["equal?"](x$27i82, 0) === false) ? ($B["equal?"](x$27i82, "") === false) : false) : false) : false)) === false) ? current$2784() : false) : false) : false)) !== false) {
        return render$2790();
      } else {
        return false;
      }
    });
    (wake$27i83 = wake$2794);
    (sleep$27i84 = sleep$2795);
    (send$27i85 = send$2783);
    (position$27i86 = position$2786);
    (current$27i87 = current$2784);
    (playing$3f$27i88 = function () {
      return (asleep$2779 === false);
    });
    (queue$27i89 = function () {
      return wanted$2770;
    });
    (state$27i90 = function () {
      return state$2771;
    });
    (reload$27i91 = function () {
      (loaded$2773 = 0);
      if ((((state$2771) !== false ? (asleep$2779 === false) : false)) !== false) {
        return render$2790();
      } else {
        return false;
      }
    });
    (media$27i92 = media$2766);
    return $B["%record-make"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", wake$27i83, sleep$27i84, send$27i85, position$27i86, current$27i87, playing$3f$27i88, queue$27i89, state$27i90, reload$27i91, media$27i92);
  });
  (note$27ui = function (words) {
    let n$27160;
    (n$27160 = make_element$27dom("div"));
    set_class$21$27dom(n$27160, "music-note");
    set_text$21$27dom(n$27160, words);
    append$21$27dom(body$27dom(), n$27160);
    after$27page(2500, function () {
      return remove$21$27dom(n$27160);
    });
    return false;
  });
  (choose$27ui = function (title, choices) {
    let d$27161, each$27164, heading$27162, option$27163;
    (d$27161 = make_element$27dom("dialog"));
    (heading$27162 = make_element$27dom("h2"));
    set_class$21$27dom(d$27161, "reel-where");
    set_text$21$27dom(heading$27162, title);
    append$21$27dom(d$27161, heading$27162);
    (option$27163 = function (label, act, $class) {
      let b$27165;
      (b$27165 = make_element$27dom("button"));
      set_text$21$27dom(b$27165, label);
      ($B["equal?"]($class, "") ? false : set_class$21$27dom(b$27165, $class));
      on$27dom(b$27165, click$27dom, function (e) {
        close_dialog$21$27dom(d$27161);
        return act();
      });
      return append$21$27dom(d$27161, b$27165);
    });
    (each$27164 = function (l) {
      for (;;) {
        if ($B["null?"](l)) {
          return true;
        } else {
          option$27163($B["car"]($B["car"](l)), $B["cdr"]($B["car"](l)), "");
          const $t0 = $B["cdr"](l);
          l = $t0;
          continue;
        }
      }
    });
    each$27164(choices);
    option$27163("Cancel", function () {
      return false;
    }, "reel-cancel");
    on$27dom(d$27161, close$27dom, function (e) {
      return remove$21$27dom(d$27161);
    });
    append$21$27dom(body$27dom(), d$27161);
    return show_modal$21$27dom(d$27161);
  });
  (pending$27playlist = false);
  (choices$27playlist = function (playlists, i, out) {
    let p$27166;
    if ((i < 0)) {
      return out;
    } else {
      (p$27166 = $B["vector-ref"](playlists, i));
      return choices$27playlist(playlists, (i - 1), $B["cons"]($B["cons"]($B["string-append"]($B["map-ref"](p$27166, "name"), $B["string-append"](" (", $B["string-append"]($B["number->string"]($B["map-ref"](p$27166, "n", 0)), ")"))), function () {
        let msg$27i93$27i95, playlist$27i94;
        (playlist$27i94 = $B["map-ref"](p$27166, "id"));
        (msg$27i93$27i95 = $B["map-of"]("type", "playlist", "op", "add", "playlist", playlist$27i94, "what", $B["map-ref"](pending$27playlist, "what"), "id", $B["map-ref"](pending$27playlist, "id")));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i93$27i95));
        } else {
          return false;
        }
      }), out));
    }
  });
  (new_playlist$27playlist = function () {
    let msg$27i96, name$27168, what$27167;
    (what$27167 = pending$27playlist);
    (name$27168 = ask$27page("The new playlist's name", ""));
    if ((name$27168) !== false) {
      (msg$27i96 = $B["map-of"]("type", "playlist", "op", "new", "name", name$27168, "what", $B["map-ref"](what$27167, "what"), "id", $B["map-ref"](what$27167, "id")));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i96));
      } else {
        return false;
      }
    } else {
      return false;
    }
  });
  (playlists_add$27playlist = function () {
    let handler$27i98, handler$27i99, save$27171;
    on_document$27dom(click$27dom, function (e) {
      let b$27169, msg$27i97, n$27170;
      (b$27169 = closest_of$27dom(e, "[data-playlist-add]"));
      if ((b$27169) !== false) {
        prevent_default$21$27dom(e);
        (pending$27playlist = $B["map-of"]("what", data_of$27dom(b$27169, "playlist-add"), "id", ((n$27170 = $B["string->number"](data_of$27dom(b$27169, "id"))), ((n$27170) !== false ? n$27170 : 0))));
        if (((msg$27i97 = $B["map-of"]("type", "playlist", "op", "list")), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i97)) : false))) {
          return false;
        } else {
          return note$27ui("Not connected to HazelFlix just now: try again in a moment.");
        }
      } else {
        return false;
      }
    });
    ((handler$27i98 = function (text, m) {
      if ((pending$27playlist) !== false) {
        return choose$27ui("Add to a playlist", $B["append"](choices$27playlist($B["map-ref"](m, "playlists", $B["vector"]()), ($B["vector-length"]($B["map-ref"](m, "playlists", $B["vector"]())) - 1), null), $listFromEnd($B["cons"]("New playlist\xe2\x80\xa6", new_playlist$27playlist))));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "playlists", $B["append"]($B["map-ref"](handlers$27socket, "playlists", null), $listFromEnd(handler$27i98)))));
    ((handler$27i99 = function (text, m) {
      (pending$27playlist = false);
      return note$27ui($B["string-append"]((($B["map-ref"](m, "n", 1) === 1) ? "Added to " : $B["string-append"]($B["number->string"]($B["map-ref"](m, "n", 1)), " added to ")), $B["string-append"]($B["map-ref"](m, "name", ""), ".")));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "playlist-added", $B["append"]($B["map-ref"](handlers$27socket, "playlist-added", null), $listFromEnd(handler$27i99)))));
    (save$27171 = by_id$27dom("player-save"));
    if ((save$27171) !== false) {
      return on$27dom(save$27171, click$27dom, function (e) {
        let msg$27i100, name$27172, queue$27173;
        (name$27172 = ask$27page("The playlist's name", ""));
        (queue$27173 = queue_now$27player);
        if (((name$27172) !== false ? (queue$27173 > 0) : false)) {
          (msg$27i100 = $B["map-of"]("type", "playlist", "op", "new", "name", name$27172, "what", "queue", "id", queue$27173));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i100));
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
    } else {
      return false;
    }
  });
  (pop_out$27playlist = function () {
    let buttons$27174, each$27175;
    (query_has$3f$27page("popout") ? ((buttons$27174 = query_all$27dom("[data-popout]")), (each$27175 = function (i) {
      for (;;) {
        if ((i < $B["vector-length"](buttons$27174))) {
          set_hidden$21$27dom($B["vector-ref"](buttons$27174, i), true);
          const $t0 = (i + 1);
          i = $t0;
          continue;
        } else {
          return false;
        }
      }
    }), each$27175(0)) : false);
    return on_document$27dom(click$27dom, function (e) {
      let b$27176, q$27179, queue$27177, w$27178;
      (b$27176 = closest_of$27dom(e, "[data-popout]"));
      if ((b$27176) !== false) {
        (queue$27177 = ((q$27179 = queue_now$27player), ((q$27179 > 0) ? q$27179 : $B["map-ref"](self$27socket, "queue", 0))));
        (w$27178 = open_window$27page($B["string-append"]("/music/player?popout=1", ((queue$27177 > 0) ? $B["string-append"]("&queue=", $B["number->string"](queue$27177)) : "")), "hazelflix-player", "popup,width=460,height=780"));
        prevent_default$21$27dom(e);
        if ((w$27178 === false)) {
          return alert$21$27page("The browser didn't open the window: allow pop-ups for HazelFlix.");
        } else {
          focus_window$21$27page(w$27178);
          if (($B["equal?"](path$27page(), "/music/player") ? (query_has$3f$27page("popout") === false) : false)) {
            return go$21$27page("/music");
          } else {
            return false;
          }
        }
      } else {
        return false;
      }
    });
  });
  (film_plays$27film = function () {
    let video$27181;
    (video$27181 = media_by_id$27media("player"));
    if ((video$27181) !== false) {
      return plays$27film(video$27181);
    } else {
      return false;
    }
  });
  (plays$27film = function (video) {
    let dragging$27197, duration$27185, f$27188, file$27183, film$27182, format$27184, live$27186, n$27180$27i101, n$27180$27i102, n$27180$27i106, offset$27187, position$27189, report$27190, seek$27195, show$27198, start$27193, time$27196;
    (film$27182 = data_of$27dom(video, "film"));
    (file$27183 = data_of$27dom(video, "file"));
    (format$27184 = ((f$27188 = data_of$27dom(video, "format")), ($B["equal?"](f$27188, "") ? "0" : f$27188)));
    (duration$27185 = ((n$27180$27i101 = $B["string->number"](data_of$27dom(video, "duration"))), ((n$27180$27i101) !== false ? (n$27180$27i101 + 0.0) : 0.0)));
    (live$27186 = $B["equal?"](data_of$27dom(video, "live"), "1"));
    (offset$27187 = (live$27186 ? ((n$27180$27i102 = $B["string->number"](data_of$27dom(video, "start"))), ((n$27180$27i102) !== false ? (n$27180$27i102 + 0.0) : 0.0)) : 0.0));
    (position$27189 = function () {
      return (offset$27187 + media_time$27media(video));
    });
    (report$27190 = function (going) {
      let at$27191, length$27192, msg$27i105, x$27i103, x$27i104;
      (at$27191 = ((x$27i103 = position$27189()), ($B["round"]((10.0 * x$27i103)) / 10.0)));
      (length$27192 = ((x$27i104 = ((duration$27185 > 0.0) ? duration$27185 : media_duration$27media(video))), ($B["round"]((10.0 * x$27i104)) / 10.0)));
      if (((going === false) ? ((msg$27i105 = $B["map-of"]("type", "progress", "film", $B["string->number"](film$27182), "file", $B["string->number"](file$27183), "position", at$27191, "duration", length$27192)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i105)) : false)) : false)) {
        return false;
      } else {
        return post_form$21$27fetch("/progress", $B["string-append"]("film=", encode_component$27page(film$27182), "&file=", encode_component$27page(file$27183), "&position=", $B["number->string"](at$27191), "&duration=", $B["number->string"](length$27192)));
      }
    });
    ((live$27186 === false) ? ((start$27193 = ((n$27180$27i106 = $B["string->number"](data_of$27dom(video, "start"))), ((n$27180$27i106) !== false ? (n$27180$27i106 + 0.0) : 0.0))), ((start$27193 > 0.0) ? on_once$27dom(video, loadedmetadata$27media, function (e) {
      return seek$21$27media(video, start$27193);
    }) : false)) : false);
    every$27page(10000, function () {
      if (media_paused$3f$27media(video)) {
        return false;
      } else {
        return report$27190(false);
      }
    });
    on$27dom(video, pause$27media, function (e) {
      return report$27190(false);
    });
    on$27dom(video, ended$27media, function (e) {
      let next$27194;
      report$27190(false);
      (next$27194 = data_of$27dom(video, "next"));
      if ($B["equal?"](next$27194, "")) {
        return false;
      } else {
        return after$27page(1500, function () {
          return go$21$27page(next$27194);
        });
      }
    });
    on_window$27page(pagehide$27page, function (e) {
      return report$27190(true);
    });
    if (live$27186) {
      (seek$27195 = by_id$27dom("live-seek"));
      (time$27196 = by_id$27dom("live-time"));
      (dragging$27197 = false);
      (show$27198 = function (s) {
        if ((time$27196) !== false) {
          return set_text$21$27dom(time$27196, $B["string-append"](clock$27clock(s), " / ", clock$27clock(duration$27185)));
        } else {
          return false;
        }
      });
      on$27dom(video, timeupdate$27media, function (e) {
        (((seek$27195) !== false ? (dragging$27197 === false) : false) ? set_field$21$27dom(seek$27195, $B["number->string"]($B["exact"]($B["floor"](position$27189())))) : false);
        return show$27198(position$27189());
      });
      if ((seek$27195) !== false) {
        on$27dom(seek$27195, input$27dom, function (e) {
          let e$27i107, n$27199$27i108;
          (dragging$27197 = true);
          return show$27198((number_of_field$27film, (e$27i107 = seek$27195), ((n$27199$27i108 = $B["string->number"](value_of$27dom(e$27i107))), ((n$27199$27i108) !== false ? (n$27199$27i108 + 0.0) : 0.0))));
        });
        return on$27dom(seek$27195, change$27dom, function (e) {
          let e$27i109, n$27199$27i110;
          (dragging$27197 = false);
          (offset$27187 = (number_of_field$27film, (e$27i109 = seek$27195), ((n$27199$27i110 = $B["string->number"](value_of$27dom(e$27i109))), ((n$27199$27i110) !== false ? (n$27199$27i110 + 0.0) : 0.0))));
          const $c0 = $B["floor"](offset$27187);
          if (!Number.isInteger($c0)) throw $notInteger;
          set_source$21$27media(video, $B["string-append"]("/live/", file$27183, "?t=", $B["number->string"]($c0), ($B["equal?"](format$27184, "0") ? "" : $B["string-append"]("&format=", format$27184))));
          return play$21$27media(video);
        });
      } else {
        return false;
      }
    } else {
      return false;
    }
  });
  (number_of_field$27film = function (e) {
    let n$27199;
    (n$27199 = $B["string->number"](value_of$27dom(e)));
    if ((n$27199) !== false) {
      return (n$27199 + 0.0);
    } else {
      return 0.0;
    }
  });
  (targets$27where = $B["vector"]());
  (asked$27where = 0);
  (asked_href$27where = "");
  (waiting$27where = 0);
  (sent$27where = 0);
  (other_screens$27where = function () {
    let from$27201, me$27200;
    (me$27200 = $B["string-append"](browser_id$27socket(), $B["string-append"](".", tab$27socket)));
    (from$27201 = function (i) {
      for (;;) {
        if ((i < 0)) {
          return null;
        } else {
          if ($B["equal?"]($B["map-ref"]($B["vector-ref"](targets$27where, i), "id", ""), me$27200)) {
            const $t0 = (i - 1);
            i = $t0;
            continue;
          } else {
            return $B["cons"]($B["vector-ref"](targets$27where, i), from$27201((i - 1)));
          }
        }
      }
    });
    return $B["reverse"](from$27201(($B["vector-length"](targets$27where) - 1)));
  });
  (screen_of$27where = function (id) {
    let from;
    (from = function (i) {
      for (;;) {
        if ((i < 0)) {
          return false;
        } else {
          if ($B["equal?"]($B["map-ref"]($B["vector-ref"](targets$27where, i), "id", ""), id)) {
            return $B["vector-ref"](targets$27where, i);
          } else {
            const $t0 = (i - 1);
            i = $t0;
            continue;
          }
        }
      }
    });
    return from(($B["vector-length"](targets$27where) - 1));
  });
  (send_to$27where = function (t, href) {
    let msg$27i111, this$27202;
    if (((msg$27i111 = $B["map-of"]("type", "play", "target", $B["map-ref"](t, "id", ""), "href", href)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i111)) : false))) {
      (this$27202 = (sent$27where + 1));
      (sent$27where = this$27202);
      (waiting$27where = this$27202);
      return after$27page(5000, function () {
        if ((waiting$27where === this$27202)) {
          (waiting$27where = 0);
          return alert$21$27page($B["string-append"]($B["map-ref"](t, "name", ""), " didn't answer."));
        } else {
          return false;
        }
      });
    } else {
      return alert$21$27page("Not connected to HazelFlix just now: try again in a moment.");
    }
  });
  (ask_where$27where = function (href, there) {
    let choices;
    (choices = function (l) {
      let t$27203;
      if ($B["null?"](l)) {
        return null;
      } else {
        (t$27203 = $B["car"](l));
        return $B["cons"]($B["cons"]($B["map-ref"](t$27203, "name", ""), function () {
          return send_to$27where(t$27203, href);
        }), choices($B["cdr"](l)));
      }
    });
    return choose$27ui("Play where?", $B["cons"]($B["cons"]("This browser", function () {
      return go$21$27page(href);
    }), choices(there)));
  });
  (ask_which$27where = function (href, there) {
    let msg$27i112, n$27204;
    (n$27204 = (asked$27where + 1));
    (asked$27where = n$27204);
    (asked_href$27where = href);
    if (((msg$27i112 = $B["map-of"]("type", "can-play", "n", n$27204, "href", href)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i112)) : false))) {
      return after$27page(1000, function () {
        if ((asked$27where === n$27204)) {
          (asked$27where = 0);
          return ask_where$27where(href, there);
        } else {
          return false;
        }
      });
    } else {
      (asked$27where = 0);
      return ask_where$27where(href, there);
    }
  });
  (only_able$27where = function (there, ids) {
    let in$3f;
    (in$3f = function (id, i) {
      for (;;) {
        if ((i < 0)) {
          return false;
        } else {
          if ($B["equal?"]($B["vector-ref"](ids, i), id)) {
            return true;
          } else {
            const $t0 = id;
            const $t1 = (i - 1);
            id = $t0;
            i = $t1;
            continue;
          }
        }
      }
    });
    if ($B["null?"](there)) {
      return null;
    } else {
      if ((in$3f($B["map-ref"]($B["car"](there), "id", ""), ($B["vector-length"](ids) - 1))) !== false) {
        return $B["cons"]($B["car"](there), only_able$27where($B["cdr"](there), ids));
      } else {
        return only_able$27where($B["cdr"](there), ids);
      }
    }
  });
  (player_link$3f$27where = function (href) {
    let b$27205$27i113, b$27205$27i114;
    if ($B["string-prefix?"]("/play/", href)) {
      if ((6 < $B["string-length"](href))) {
        (b$27205$27i113 = $B["byte-ref"](href, 6));
        if ((b$27205$27i113 >= 48)) {
          return (b$27205$27i113 <= 57);
        } else {
          return false;
        }
      } else {
        return false;
      }
    } else {
      if ($B["string-prefix?"]("/watch/", href)) {
        if ((7 < $B["string-length"](href))) {
          (b$27205$27i114 = $B["byte-ref"](href, 7));
          if ((b$27205$27i114 >= 48)) {
            return (b$27205$27i114 <= 57);
          } else {
            return false;
          }
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
  });
  (play_where$27where = function () {
    let handler$27i115, handler$27i116, handler$27i117, handler$27i118;
    ((handler$27i115 = function (text, m) {
      return (targets$27where = $B["map-ref"](m, "targets", $B["vector"]()));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "targets", $B["append"]($B["map-ref"](handlers$27socket, "targets", null), $listFromEnd(handler$27i115)))));
    ((handler$27i116 = function (text, m) {
      if ((waiting$27where > 0)) {
        (waiting$27where = 0);
        return go$21$27page($B["string-append"]("/remote?target=", encode_component$27page($B["map-ref"](m, "target", ""))));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "played", $B["append"]($B["map-ref"](handlers$27socket, "played", null), $listFromEnd(handler$27i116)))));
    ((handler$27i117 = function (text, m) {
      if ((waiting$27where > 0)) {
        (waiting$27where = 0);
        return alert$21$27page($B["map-ref"](m, "why", ""));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "failed", $B["append"]($B["map-ref"](handlers$27socket, "failed", null), $listFromEnd(handler$27i117)))));
    ((handler$27i118 = function (text, m) {
      let able$27206, href$27207;
      if (((asked$27where > 0) ? ($B["map-ref"](m, "n", 0) === asked$27where) : false)) {
        (able$27206 = only_able$27where(other_screens$27where(), $B["map-ref"](m, "targets", $B["vector"]())));
        (href$27207 = asked_href$27where);
        (asked$27where = 0);
        if ($B["null?"](able$27206)) {
          return go$21$27page(href$27207);
        } else {
          return ask_where$27where(href$27207, able$27206);
        }
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "can-play", $B["append"]($B["map-ref"](handlers$27socket, "can-play", null), $listFromEnd(handler$27i118)))));
    return on_document$27dom(click$27dom, function (e) {
      let a$27208, href$27209, there$27210;
      (a$27208 = closest_of$27dom(e, "a[href]"));
      if (((a$27208) !== false ? ((default_prevented$3f$27dom(e) === false) ? (plain_click$3f$27dom(e) ? (by_id$27dom("ready") === false) : false) : false) : false)) {
        (href$27209 = attribute_of$27dom(a$27208, "href"));
        (there$27210 = other_screens$27where());
        if ((player_link$3f$27where(href$27209) ? (($B["null?"](there$27210) === false) ? dialogs$3f$27dom() : false) : false)) {
          prevent_default$21$27dom(e);
          return ask_which$27where(href$27209, there$27210);
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
  });
  (text$21$27ready = function (id, text) {
    let e$27211;
    (e$27211 = by_id$27dom(id));
    if ((e$27211) !== false) {
      return set_text$21$27dom(e$27211, text);
    } else {
      return false;
    }
  });
  (ready_to_play$27ready = function () {
    let ready$27212, video$27213;
    (ready$27212 = by_id$27dom("ready"));
    (video$27213 = media_by_id$27media("screen"));
    if ((((ready$27212) !== false ? video$27213 : false)) !== false) {
      return screen_plays$27ready(video$27213);
    } else {
      return false;
    }
  });
  (screen_plays$27ready = function (video) {
    let card$27217, duration$27225, film$27220, film$27i146, films$27218, handler$27i152, handler$27i159, handler$27i162, handler$27i178, item$27219, loaded$27229, on_load$27i147, on_sleep$27i149, on_wake$27i148, player$27222, reached$27221, report$27227, screen$27216, show_name$27224, start$27214, state$27226, still$27223, stirred$27228, stop$27230, wait$27215;
    (start$27214 = by_id$27dom("ready-start"));
    (wait$27215 = by_id$27dom("ready-wait"));
    (screen$27216 = by_id$27dom("ready-screen"));
    (card$27217 = by_id$27dom("ready-card"));
    (films$27218 = $B["map-of"]());
    (item$27219 = false);
    (film$27220 = false);
    (reached$27221 = 0.0);
    (player$27222 = false);
    (still$27223 = 0);
    (show_name$27224 = function () {
      let name$27231;
      (name$27231 = $B["map-ref"](self$27socket, "name", ""));
      if ($B["equal?"](name$27231, "")) {
        return false;
      } else {
        text$21$27ready("ready-hint-name", $B["string-append"]("\xe2\x80\x9c", name$27231, "\xe2\x80\x9d"));
        return text$21$27ready("ready-name", ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") ? $B["string-append"]("This screen is ", name$27231, ".") : $B["string-append"]("This screen is ", name$27231, ": set it to Play in Settings, Browsers, so others can send to it.")));
      }
    });
    (duration$27225 = function () {
      let x$27i119, x$27i120;
      if ($B["map?"](film$27220)) {
        (x$27i119 = $B["map-ref"](film$27220, "duration", 0));
        if ($B["number?"](x$27i119)) {
          return (x$27i119 + 0.0);
        } else {
          return 0.0;
        }
      } else {
        if ($B["map?"](item$27219)) {
          (x$27i120 = $B["map-ref"](item$27219, "duration", 0));
          if ($B["number?"](x$27i120)) {
            return (x$27i120 + 0.0);
          } else {
            return 0.0;
          }
        } else {
          return 0.0;
        }
      }
    });
    (state$27226 = function () {
      let msg$27i127, r$27i121, x$27i122, x$27i123, x$27i124, x$27i125, x$27i126;
      (msg$27i127 = $B["map-of"]("type", "state", "playing", ($B["map?"](item$27219) ? true : false), "paused", media_paused$3f$27media(video), "position", ((x$27i122 = ((r$27i121 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i121))()), $B["exact"]($B["floor"](($B["number?"](x$27i122) ? (x$27i122 + 0.0) : 0.0)))), "duration", ((x$27i123 = duration$27225()), $B["exact"]($B["floor"](($B["number?"](x$27i123) ? (x$27i123 + 0.0) : 0.0)))), "title", ($B["map?"](item$27219) ? ((x$27i124 = $B["map-ref"](item$27219, "title", "")), ($B["string?"](x$27i124) ? x$27i124 : ($B["number?"](x$27i124) ? $B["number->string"](x$27i124) : ""))) : ""), "label", text_of$27dom(by_id$27dom("ready-label")), "poster", ($B["map?"](film$27220) ? ((x$27i125 = $B["map-ref"](film$27220, "poster", "")), ($B["string?"](x$27i125) ? x$27i125 : ($B["number?"](x$27i125) ? $B["number->string"](x$27i125) : ""))) : ($B["map?"](item$27219) ? ((x$27i126 = $B["map-ref"](item$27219, "art", "")), ($B["string?"](x$27i126) ? x$27i126 : ($B["number?"](x$27i126) ? $B["number->string"](x$27i126) : ""))) : "")), "volume", volume$27media(video), "muted", muted$3f$27media(video), "subtitles", ($B["map?"](film$27220) ? $B["map-ref"](film$27220, "subtitles", 0) : 0), "subtitlesOn", subtitles_showing$3f$27media(video), "next", ($B["map?"](film$27220) ? $B["map-ref"](film$27220, "next", 0) : 0)));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i127));
      } else {
        return false;
      }
    });
    (report$27227 = function () {
      let msg$27i131, x$27i128, x$27i129, x$27i130;
      if (($B["map?"](film$27220) ? (reached$27221 > 0.0) : false)) {
        (msg$27i131 = $B["map-of"]("type", "progress", "film", $B["map-ref"](film$27220, "film", 0), "file", $B["map-ref"](film$27220, "file", 0), "position", ((x$27i128 = reached$27221), ($B["round"]((10.0 * x$27i128)) / 10.0)), "duration", ((x$27i130 = ((x$27i129 = $B["map-ref"](film$27220, "duration", 0)), ($B["number?"](x$27i129) ? (x$27i129 + 0.0) : 0.0))), ($B["round"]((10.0 * x$27i130)) / 10.0))));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i131));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    (stirred$27228 = function () {
      remove_class$21$27dom(screen$27216, "still");
      cancel_timer$21$27page(still$27223);
      return (still$27223 = after$27page(3000, function () {
        return add_class$21$27dom(screen$27216, "still");
      }));
    });
    (loaded$27229 = function (i, p) {
      let album$27233, art$27239, artist$27232, each$27235, each$27236, or$27value$27238, tracks$27234, x$27i132, x$27i133, x$27i134, x$27i135, x$27i138, x$27i139, x$27i140, x$27i141, x$27i142;
      report$27227();
      (item$27219 = i);
      (film$27220 = p);
      (reached$27221 = 0.0);
      text$21$27ready("ready-title", ((x$27i132 = $B["map-ref"](i, "title", "")), ($B["string?"](x$27i132) ? x$27i132 : ($B["number?"](x$27i132) ? $B["number->string"](x$27i132) : ""))));
      text$21$27ready("ready-label", ($B["map?"](p) ? ((x$27i133 = $B["map-ref"](p, "label", "")), ($B["string?"](x$27i133) ? x$27i133 : ($B["number?"](x$27i133) ? $B["number->string"](x$27i133) : ""))) : ((artist$27232 = ((x$27i134 = $B["map-ref"](i, "artist", "")), ($B["string?"](x$27i134) ? x$27i134 : ($B["number?"](x$27i134) ? $B["number->string"](x$27i134) : "")))), (album$27233 = ((x$27i135 = $B["map-ref"](i, "album", "")), ($B["string?"](x$27i135) ? x$27i135 : ($B["number?"](x$27i135) ? $B["number->string"](x$27i135) : "")))), ($B["equal?"](artist$27232, "") ? album$27233 : ($B["equal?"](album$27233, "") ? artist$27232 : $B["string-append"](artist$27232, " \xc2\xb7 ", album$27233))))));
      text$21$27ready("ready-time", "");
      ((tracks$27234 = query_all_in$27dom(video, "track")), ((each$27235 = function (n) {
        for (;;) {
          if ((n < $B["vector-length"](tracks$27234))) {
            remove$21$27dom($B["vector-ref"](tracks$27234, n));
            const $t0 = (n + 1);
            n = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27235(0)));
      ($B["map?"](p) ? ((each$27236 = function (n) {
        let t$27237, x$27i136, x$27i137;
        for (;;) {
          if ((n < ((x$27i136 = $B["map-ref"](p, "subtitles", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i136) ? (x$27i136 + 0.0) : 0.0)))))) {
            (t$27237 = make_element$27dom("track"));
            set_attribute$21$27dom(t$27237, "kind", "subtitles");
            set_attribute$21$27dom(t$27237, "srclang", "en");
            set_attribute$21$27dom(t$27237, "src", $B["string-append"]("/subs/", ((x$27i137 = $B["map-ref"](p, "file", 0)), ($B["string?"](x$27i137) ? x$27i137 : ($B["number?"](x$27i137) ? $B["number->string"](x$27i137) : ""))), "/", $B["number->string"](n)));
            ((n === 0) ? set_attribute$21$27dom(t$27237, "default", "") : false);
            append$21$27dom(video, t$27237);
            const $t0 = (n + 1);
            n = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27236(0)) : false);
      set_poster$21$27media(video, ($B["map?"](p) ? ((x$27i138 = $B["map-ref"](p, "poster", "")), ($B["string?"](x$27i138) ? x$27i138 : ($B["number?"](x$27i138) ? $B["number->string"](x$27i138) : ""))) : ""));
      set_hidden$21$27dom(card$27217, ((or$27value$27238 = $B["map?"](p)), (or$27value$27238 ? or$27value$27238 : $B["equal?"]($B["map-ref"](i, "kind", ""), "video"))));
      text$21$27ready("ready-card-title", ((x$27i139 = $B["map-ref"](i, "title", "")), ($B["string?"](x$27i139) ? x$27i139 : ($B["number?"](x$27i139) ? $B["number->string"](x$27i139) : ""))));
      text$21$27ready("ready-card-artist", ((x$27i140 = $B["map-ref"](i, "artist", "")), ($B["string?"](x$27i140) ? x$27i140 : ($B["number?"](x$27i140) ? $B["number->string"](x$27i140) : ""))));
      text$21$27ready("ready-card-album", ((x$27i141 = $B["map-ref"](i, "album", "")), ($B["string?"](x$27i141) ? x$27i141 : ($B["number?"](x$27i141) ? $B["number->string"](x$27i141) : ""))));
      ((art$27239 = ((x$27i142 = $B["map-ref"](i, "art", "")), ($B["string?"](x$27i142) ? x$27i142 : ($B["number?"](x$27i142) ? $B["number->string"](x$27i142) : "")))), set_style$21$27dom(by_id$27dom("ready-card-back"), "background-image", ($B["equal?"](art$27239, "") ? "none" : $B["string-append"]("url(\"", art$27239, "\")"))));
      stirred$27228();
      return state$27226();
    });
    (stop$27230 = function () {
      let r$27i143, r$27i144, r$27i145;
      if (((r$27i143 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i143))()) {
        ((r$27i144 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i144))("pause", null);
        return ((r$27i145 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r$27i145))();
      } else {
        return false;
      }
    });
    (player$27222 = start_player$27player(screen$27216, ((film$27i146 = function (i) {
      return $B["map-ref"](films$27218, $B["map-ref"](i, "file", 0), false);
    }), (on_load$27i147 = loaded$27229), (on_wake$27i148 = function () {
      set_hidden$21$27dom(start$27214, true);
      set_hidden$21$27dom(wait$27215, true);
      set_hidden$21$27dom(screen$27216, false);
      stirred$27228();
      return false;
    }), (on_sleep$27i149 = function () {
      report$27227();
      (item$27219 = false);
      (film$27220 = false);
      set_hidden$21$27dom(screen$27216, true);
      set_hidden$21$27dom(wait$27215, (hidden$3f$27dom(start$27214) === false));
      state$27226();
      return false;
    }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", true, false, film$27i146, on_load$27i147, on_wake$27i148, on_sleep$27i149))));
    on$27dom(by_id$27dom("ready-go"), click$27dom, function (e) {
      play$21$27media(video);
      pause$21$27media(video);
      fullscreen$21$27page();
      set_hidden$21$27dom(start$27214, true);
      set_hidden$21$27dom(wait$27215, false);
      add_class$21$27dom(body$27dom(), "ready-on");
      show_name$27224();
      return again$27intro();
    });
    on$27dom(by_id$27dom("ready-home"), click$27dom, function (e) {
      return stop$27230();
    });
    on$27dom(video, timeupdate$27media, function (e) {
      let at$27240, length$27241, r$27i150;
      (at$27240 = ((r$27i150 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i150))());
      (length$27241 = duration$27225());
      (($B["map?"](item$27219) ? (media_time$27media(video) > 0.0) : false) ? (reached$27221 = at$27240) : false);
      return text$21$27ready("ready-time", (($B["map?"](item$27219) ? (length$27241 > 0.0) : false) ? $B["string-append"](clock$27clock(at$27240), " / ", clock$27clock((length$27241 - at$27240))) : ""));
    });
    on$27dom(video, ended$27media, function (e) {
      let q$27242, r$27i151;
      (q$27242 = ((r$27i151 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r$27i151))());
      if (((q$27242) !== false ? (($B["map-ref"](q$27242, "at", 0) >= ($B["vector-length"]($B["map-ref"](q$27242, "items", $B["vector"]())) - 1)) ? $B["equal?"]($B["map-ref"](q$27242, "repeat", ""), "off") : false) : false)) {
        report$27227();
        return after$27page(500, stop$27230);
      } else {
        return false;
      }
    });
    on$27dom(screen$27216, mousemove$27dom, function (e) {
      return stirred$27228();
    });
    on$27dom(screen$27216, pointerdown$27dom, function (e) {
      return stirred$27228();
    });
    on$27dom(screen$27216, touchstart$27dom, function (e) {
      return stirred$27228();
    });
    on_document$27dom(keydown$27dom, function (e) {
      if (hidden$3f$27dom(screen$27216)) {
        return false;
      } else {
        return stirred$27228();
      }
    });
    on$27dom(video, play$27media, function (e) {
      return state$27226();
    });
    on$27dom(video, pause$27media, function (e) {
      state$27226();
      return report$27227();
    });
    on$27dom(video, volumechange$27media, function (e) {
      return state$27226();
    });
    on$27dom(video, seeked$27media, function (e) {
      return state$27226();
    });
    every$27page(1000, function () {
      if (($B["map?"](item$27219) ? (media_paused$3f$27media(video) === false) : false)) {
        return state$27226();
      } else {
        return false;
      }
    });
    every$27page(10000, function () {
      if (($B["map?"](item$27219) ? (media_paused$3f$27media(video) === false) : false)) {
        return report$27227();
      } else {
        return false;
      }
    });
    ((handler$27i152 = function (text, m) {
      return show_name$27224();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i152)))));
    ((handler$27i159 = function (text, p) {
      let r$27i153, r$27i154, r$27i156, r$27i157, x$27i155, x$27i158;
      (films$27218 = $B["map-set"](films$27218, $B["map-ref"](p, "file", 0), p));
      if ((((r$27i153 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i153))() ? (((r$27i154 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i154))() === ((x$27i155 = $B["map-ref"](p, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i155) ? (x$27i155 + 0.0) : 0.0))))) : false)) {
        return ((r$27i156 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 8, r$27i156))();
      } else {
        return ((r$27i157 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i157))(((x$27i158 = $B["map-ref"](p, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i158) ? (x$27i158 + 0.0) : 0.0)))));
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "play", $B["append"]($B["map-ref"](handlers$27socket, "play", null), $listFromEnd(handler$27i159)))));
    ((handler$27i162 = function (text, m) {
      let r$27i160, x$27i161;
      return ((r$27i160 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i160))(((x$27i161 = $B["map-ref"](m, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i161) ? (x$27i161 + 0.0) : 0.0)))));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "music", $B["append"]($B["map-ref"](handlers$27socket, "music", null), $listFromEnd(handler$27i162)))));
    (handler$27i178 = function (text, m) {
      let at$27245, c$27243, or$27value$27246, or$27value$27247, or$27value$27249, q$27244, r$27i163, r$27i164, r$27i165, r$27i168, r$27i169, r$27i171, r$27i173, r$27i175, r$27i176, r$27i177, v$27248, x$27i166, x$27i167, x$27i170, x$27i172, x$27i174;
      (c$27243 = $B["map-ref"](m, "command", ""));
      (q$27244 = ((r$27i163 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r$27i163))());
      (at$27245 = ((r$27i164 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i164))());
      ($B["equal?"](c$27243, "stop") ? stop$27230() : ((((r$27i165 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i165))() === false) ? false : (((or$27value$27246 = $B["equal?"](c$27243, "toggle")), (or$27value$27246 ? or$27value$27246 : ((or$27value$27247 = ($B["equal?"](c$27243, "play") ? ((q$27244) !== false ? ((x$27i166 = $B["map-ref"](q$27244, "paused", false)), ((x$27i166) !== false ? (((x$27i166 === $sym("null")) === false) ? (($B["equal?"](x$27i166, 0) === false) ? ($B["equal?"](x$27i166, "") === false) : false) : false) : false)) : false) : false)), (or$27value$27247 ? or$27value$27247 : ($B["equal?"](c$27243, "pause") ? ((q$27244) !== false ? (((x$27i167 = $B["map-ref"](q$27244, "paused", false)), ((x$27i167) !== false ? (((x$27i167 === $sym("null")) === false) ? (($B["equal?"](x$27i167, 0) === false) ? ($B["equal?"](x$27i167, "") === false) : false) : false) : false)) === false) : false) : false))))) ? ((r$27i168 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i168))("toggle", null) : ($B["equal?"](c$27243, "back") ? ((r$27i169 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i169))("seek", $listFromEnd($B["cons"]("value", ((v$27248 = ((x$27i170 = (at$27245 - 10.0)), $B["exact"]($B["floor"](($B["number?"](x$27i170) ? (x$27i170 + 0.0) : 0.0))))), ((v$27248 > 0) ? v$27248 : 0))))) : ($B["equal?"](c$27243, "forward") ? ((r$27i171 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i171))("seek", $listFromEnd($B["cons"]("value", ((x$27i172 = (at$27245 + 30.0)), $B["exact"]($B["floor"](($B["number?"](x$27i172) ? (x$27i172 + 0.0) : 0.0))))))) : ($B["equal?"](c$27243, "seek") ? ((r$27i173 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i173))("seek", $listFromEnd($B["cons"]("value", ((x$27i174 = $B["map-ref"](m, "value", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i174) ? (x$27i174 + 0.0) : 0.0))))))) : ($B["equal?"](c$27243, "next") ? ((r$27i175 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i175))("next", null) : ($B["equal?"](c$27243, "prev") ? ((r$27i176 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i176))("prev", null) : ($B["equal?"](c$27243, "volume-down") ? set_volume$21$27media(video, (volume$27media(video) - 0.10000000000000001)) : ($B["equal?"](c$27243, "volume-up") ? (set_muted$21$27media(video, false), set_volume$21$27media(video, (volume$27media(video) + 0.10000000000000001))) : ($B["equal?"](c$27243, "mute") ? set_muted$21$27media(video, (muted$3f$27media(video) === false)) : ($B["equal?"](c$27243, "subtitles") ? show_subtitles$21$27media(video, (subtitles_showing$3f$27media(video) ? -1 : 0)) : false))))))))))));
      if ((((or$27value$27249 = $B["equal?"](c$27243, "stop")), (or$27value$27249 ? or$27value$27249 : ((r$27i177 = player$27222), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i177))()))) !== false) {
        return state$27226();
      } else {
        return false;
      }
    });
    return (handlers$27socket = $B["map-set"](handlers$27socket, "control", $B["append"]($B["map-ref"](handlers$27socket, "control", null), $listFromEnd(handler$27i178))));
  });
  (hide$21$27remote = function (id, hidden) {
    let e$27250;
    (e$27250 = by_id$27dom(id));
    if ((e$27250) !== false) {
      return set_hidden$21$27dom(e$27250, hidden);
    } else {
      return false;
    }
  });
  (text$21$27remote = function (id, text) {
    let e$27251;
    (e$27251 = by_id$27dom(id));
    if ((e$27251) !== false) {
      return set_text$21$27dom(e$27251, text);
    } else {
      return false;
    }
  });
  (as_queue$27remote = $B["map-of"]("toggle", "toggle", "play", "toggle", "pause", "toggle", "next", "next", "prev", "prev", "seek", "seek", "back", "seek", "forward", "seek"));
  (remote_controls$27remote = function () {
    let remote$27252;
    (remote$27252 = by_id$27dom("remote"));
    if ((remote$27252) !== false) {
      return controls$27remote(remote$27252);
    } else {
      return false;
    }
  });
  (controls$27remote = function (remote) {
    let button$27320, chosen$27253, command$27273, dragging$27254, find_playing$27265, from_queue$27263, handler$27i205, handler$27i208, handler$27i209, handler$27i210, has$3f$27266, list$27321, listed$27261, listing$27260, names$27255, names_of$27267, others$27264, queue_of$27262, queue_row$27272, queue_shape$27271, queues$27257, render$27269, seek$27259, seek_value$27274, show_queue$27270, states$27256, tab$21$27268, tabs$27258;
    (chosen$27253 = data_of$27dom(remote, "target"));
    (dragging$27254 = false);
    (names$27255 = "");
    (states$27256 = $B["map-of"]());
    (queues$27257 = $B["map-of"]());
    (tabs$27258 = by_id$27dom("remote-tabs"));
    (seek$27259 = by_id$27dom("remote-seek"));
    (listing$27260 = false);
    (listed$27261 = "");
    (queue_of$27262 = function (t) {
      let x$27i179;
      if (($B["map?"](t) ? (((x$27i179 = $B["map-ref"](t, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i179) ? (x$27i179 + 0.0) : 0.0)))) > 0) : false)) {
        return $B["map-ref"](queues$27257, $B["map-ref"](t, "queue", 0), false);
      } else {
        return false;
      }
    });
    (from_queue$27263 = function (t) {
      let item$27276, kind$27277, or$27value$27279, paused$27278, q$27275, x$27i180, x$27i181, x$27i182, x$27i183, x$27i184, x$27i185, x$27i186, x$27i187;
      (q$27275 = queue_of$27262(t));
      if (((q$27275) !== false ? ($B["vector-length"]($B["map-ref"](q$27275, "items", $B["vector"]())) > 0) : false)) {
        (item$27276 = $B["vector-ref"]($B["map-ref"](q$27275, "items", $B["vector"]()), $B["map-ref"](q$27275, "at", 0)));
        (kind$27277 = $B["map-ref"](item$27276, "kind", ""));
        (paused$27278 = ((x$27i180 = $B["map-ref"](q$27275, "paused", false)), ((x$27i180) !== false ? (((x$27i180 === $sym("null")) === false) ? (($B["equal?"](x$27i180, 0) === false) ? ($B["equal?"](x$27i180, "") === false) : false) : false) : false)));
        if (((or$27value$27279 = $B["equal?"](kind$27277, "film")), (or$27value$27279 ? or$27value$27279 : $B["equal?"](kind$27277, "episode")))) {
          return false;
        } else {
          return $B["map-of"]("playing", true, "paused", paused$27278, "music", true, "title", ((x$27i181 = $B["map-ref"](item$27276, "title", "")), ($B["string?"](x$27i181) ? x$27i181 : ($B["number?"](x$27i181) ? $B["number->string"](x$27i181) : ""))), "label", ((x$27i182 = $B["map-ref"](item$27276, "artist", "")), ($B["string?"](x$27i182) ? x$27i182 : ($B["number?"](x$27i182) ? $B["number->string"](x$27i182) : ""))), "poster", ((x$27i183 = $B["map-ref"](item$27276, "art", "")), ($B["string?"](x$27i183) ? x$27i183 : ($B["number?"](x$27i183) ? $B["number->string"](x$27i183) : ""))), "next", 1, "subtitles", 0, "duration", ((x$27i184 = $B["map-ref"](item$27276, "duration", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i184) ? (x$27i184 + 0.0) : 0.0)))), "position", ((x$27i187 = (((x$27i185 = $B["map-ref"](q$27275, "position", 0)), ($B["number?"](x$27i185) ? (x$27i185 + 0.0) : 0.0)) + (paused$27278 ? 0.0 : ((now_ms$27page() - ((x$27i186 = $B["map-ref"](q$27275, "received", 0)), ($B["number?"](x$27i186) ? (x$27i186 + 0.0) : 0.0))) / 1000.0)))), $B["exact"]($B["floor"](($B["number?"](x$27i187) ? (x$27i187 + 0.0) : 0.0)))), "queue", $B["map-ref"](q$27275, "id", 0));
        }
      } else {
        return false;
      }
    });
    (others$27264 = function () {
      return other_screens$27where();
    });
    (find_playing$27265 = function (l) {
      let x$27i188;
      for (;;) {
        if ($B["null?"](l)) {
          return false;
        } else {
          if (((x$27i188 = $B["map-ref"]($B["map-ref"](states$27256, $B["map-ref"]($B["car"](l), "id", ""), $B["map-of"]()), "playing", false)), ((x$27i188) !== false ? (((x$27i188 === $sym("null")) === false) ? (($B["equal?"](x$27i188, 0) === false) ? ($B["equal?"](x$27i188, "") === false) : false) : false) : false))) {
            return $B["car"](l);
          } else {
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      }
    });
    (has$3f$27266 = function (l, id) {
      for (;;) {
        if ($B["null?"](l)) {
          return false;
        } else {
          if ($B["equal?"]($B["map-ref"]($B["car"](l), "id", ""), id)) {
            return true;
          } else {
            const $t0 = $B["cdr"](l);
            const $t1 = id;
            l = $t0;
            id = $t1;
            continue;
          }
        }
      }
    });
    (names_of$27267 = function (l) {
      if ($B["null?"](l)) {
        return "";
      } else {
        return $B["string-append"]($B["map-ref"]($B["car"](l), "id", ""), "\n", $B["map-ref"]($B["car"](l), "name", ""), "\n", names_of$27267($B["cdr"](l)));
      }
    });
    (tab$21$27268 = function (t) {
      let b$27280;
      (b$27280 = make_element$27dom("button"));
      set_attribute$21$27dom(b$27280, "type", "button");
      set_attribute$21$27dom(b$27280, "role", "tab");
      set_attribute$21$27dom(b$27280, "data-screen", $B["map-ref"](t, "id", ""));
      set_text$21$27dom(b$27280, $B["map-ref"](t, "name", ""));
      return append$21$27dom(tabs$27258, b$27280);
    });
    (render$27269 = function () {
      let buttons$27285, duration$27297, each$27284, each$27286, list$27281, now$27283, or$27value$27290, or$27value$27291, or$27value$27292, or$27value$27293, or$27value$27294, or$27value$27300, playing$27282, playing$27289, position$27298, poster$27295, q$27299, s$27288, src$27296, subtitles$27301, x$27i189, x$27i190, x$27i191, x$27i192, x$27i193, x$27i194, x$27i195, x$27i196, x$27i197, x$27i198;
      (list$27281 = others$27264());
      hide$21$27remote("remote-ready", ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") === false));
      hide$21$27remote("remote-none", ($B["null?"](list$27281) === false));
      ((has$3f$27266(list$27281, chosen$27253)) !== false ? false : ((playing$27282 = find_playing$27265(list$27281)), (chosen$27253 = ((playing$27282) !== false ? $B["map-ref"](playing$27282, "id", "") : ($B["null?"](list$27281) ? "" : $B["map-ref"]($B["car"](list$27281), "id", ""))))));
      ((now$27283 = names_of$27267(list$27281)), ($B["equal?"](now$27283, names$27255) ? false : ((names$27255 = now$27283), clear$21$27dom(tabs$27258), ((each$27284 = function (l) {
        for (;;) {
          if ($B["null?"](l)) {
            return false;
          } else {
            tab$21$27268($B["car"](l));
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      }), each$27284(list$27281)))));
      ((buttons$27285 = query_all$27dom("#remote-tabs [data-screen]")), (each$27286 = function (i) {
        let b$27287;
        for (;;) {
          if ((i < $B["vector-length"](buttons$27285))) {
            (b$27287 = $B["vector-ref"](buttons$27285, i));
            set_attribute$21$27dom(b$27287, "aria-selected", ($B["equal?"](data_of$27dom(b$27287, "screen"), chosen$27253) ? "true" : "false"));
            const $t0 = (i + 1);
            i = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27286(0));
      (s$27288 = ((or$27value$27290 = from_queue$27263(screen_of$27where(chosen$27253))), ((or$27value$27290) !== false ? or$27value$27290 : $B["map-ref"](states$27256, chosen$27253, false))));
      (playing$27289 = ((s$27288) !== false ? ((x$27i189 = $B["map-ref"](s$27288, "playing", false)), ((x$27i189) !== false ? (((x$27i189 === $sym("null")) === false) ? (($B["equal?"](x$27i189, 0) === false) ? ($B["equal?"](x$27i189, "") === false) : false) : false) : false)) : false));
      hide$21$27remote("remote-now", (playing$27289 === false));
      hide$21$27remote("remote-idle", ((or$27value$27291 = $B["equal?"](chosen$27253, "")), (or$27value$27291 ? or$27value$27291 : ((or$27value$27292 = playing$27289), (or$27value$27292 ? or$27value$27292 : $B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play"))))));
      hide$21$27remote("remote-idle-ready", ((or$27value$27293 = $B["equal?"](chosen$27253, "")), (or$27value$27293 ? or$27value$27293 : ((or$27value$27294 = playing$27289), (or$27value$27294 ? or$27value$27294 : ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") === false))))));
      if (playing$27289) {
        (poster$27295 = by_id$27dom("remote-poster"));
        (src$27296 = ((x$27i190 = $B["map-ref"](s$27288, "poster", "")), ($B["string?"](x$27i190) ? x$27i190 : ($B["number?"](x$27i190) ? $B["number->string"](x$27i190) : ""))));
        (duration$27297 = ((x$27i191 = $B["map-ref"](s$27288, "duration", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i191) ? (x$27i191 + 0.0) : 0.0)))));
        (position$27298 = ((x$27i192 = $B["map-ref"](s$27288, "position", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i192) ? (x$27i192 + 0.0) : 0.0)))));
        (q$27299 = queue_of$27262(screen_of$27where(chosen$27253)));
        ((poster$27295) !== false ? (set_hidden$21$27dom(poster$27295, $B["equal?"](src$27296, "")), ((($B["equal?"](src$27296, "") === false) ? ($B["equal?"](attribute_of$27dom(poster$27295, "src"), src$27296) === false) : false) ? set_attribute$21$27dom(poster$27295, "src", src$27296) : false)) : false);
        text$21$27remote("remote-title", ((x$27i193 = $B["map-ref"](s$27288, "title", "")), ($B["string?"](x$27i193) ? x$27i193 : ($B["number?"](x$27i193) ? $B["number->string"](x$27i193) : ""))));
        text$21$27remote("remote-label", ((x$27i194 = $B["map-ref"](s$27288, "label", "")), ($B["string?"](x$27i194) ? x$27i194 : ($B["number?"](x$27i194) ? $B["number->string"](x$27i194) : ""))));
        (dragging$27254 ? false : (set_attribute$21$27dom(seek$27259, "max", $B["number->string"](duration$27297)), set_field$21$27dom(seek$27259, $B["number->string"](position$27298)), text$21$27remote("remote-time", $B["string-append"](clock$27clock((0.0 + position$27298)), " / ", clock$27clock((0.0 + duration$27297))))));
        hide$21$27remote("remote-play", (((x$27i195 = $B["map-ref"](s$27288, "paused", false)), ((x$27i195) !== false ? (((x$27i195 === $sym("null")) === false) ? (($B["equal?"](x$27i195, 0) === false) ? ($B["equal?"](x$27i195, "") === false) : false) : false) : false)) === false));
        hide$21$27remote("remote-pause", ((x$27i196 = $B["map-ref"](s$27288, "paused", false)), ((x$27i196) !== false ? (((x$27i196 === $sym("null")) === false) ? (($B["equal?"](x$27i196, 0) === false) ? ($B["equal?"](x$27i196, "") === false) : false) : false) : false)));
        hide$21$27remote("remote-next-slot", ((q$27299) !== false ? (((or$27value$27300 = ($B["map-ref"](q$27299, "at", 0) < ($B["vector-length"]($B["map-ref"](q$27299, "items", $B["vector"]())) - 1))), (or$27value$27300 ? or$27value$27300 : $B["equal?"]($B["map-ref"](q$27299, "repeat", ""), "all"))) === false) : (((x$27i197 = $B["map-ref"](s$27288, "next", false)), ((x$27i197) !== false ? (((x$27i197 === $sym("null")) === false) ? (($B["equal?"](x$27i197, 0) === false) ? ($B["equal?"](x$27i197, "") === false) : false) : false) : false)) === false)));
        hide$21$27remote("remote-prev-slot", (((q$27299) !== false ? ($B["vector-length"]($B["map-ref"](q$27299, "items", $B["vector"]())) > 0) : false) === false));
        ((subtitles$27301 = query_in$27dom(remote, "[data-command=subtitles]")), ((subtitles$27301) !== false ? set_hidden$21$27dom(subtitles$27301, (((x$27i198 = $B["map-ref"](s$27288, "subtitles", false)), ((x$27i198) !== false ? (((x$27i198 === $sym("null")) === false) ? (($B["equal?"](x$27i198, 0) === false) ? ($B["equal?"](x$27i198, "") === false) : false) : false) : false)) === false)) : false));
        return show_queue$27270(q$27299);
      } else {
        return false;
      }
    });
    (show_queue$27270 = function (q) {
      let at$27304, each$27306, items$27303, list$27302, shape$27305;
      (list$27302 = by_id$27dom("remote-queue"));
      if ((list$27302) !== false) {
        if (((listing$27260 ? q : false) === false)) {
          set_hidden$21$27dom(list$27302, true);
          return (listed$27261 = "");
        } else {
          (items$27303 = $B["map-ref"](q, "items", $B["vector"]()));
          (at$27304 = $B["map-ref"](q, "at", 0));
          (shape$27305 = queue_shape$27271(items$27303, at$27304));
          set_hidden$21$27dom(list$27302, false);
          if ($B["equal?"](shape$27305, listed$27261)) {
            return false;
          } else {
            (listed$27261 = shape$27305);
            clear$21$27dom(list$27302);
            (each$27306 = function (i) {
              for (;;) {
                if ((i < $B["vector-length"](items$27303))) {
                  append$21$27dom(list$27302, queue_row$27272($B["vector-ref"](items$27303, i), (i === at$27304)));
                  const $t0 = (i + 1);
                  i = $t0;
                  continue;
                } else {
                  return false;
                }
              }
            });
            return each$27306(0);
          }
        }
      } else {
        return false;
      }
    });
    (queue_shape$27271 = function (items, at) {
      let each$27307;
      (each$27307 = function (i, out) {
        let x$27i199;
        for (;;) {
          if ((i < $B["vector-length"](items))) {
            const $t0 = (i + 1);
            const $t1 = $B["string-append"](out, ";", $B["number->string"](((x$27i199 = $B["map-ref"]($B["vector-ref"](items, i), "id", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i199) ? (x$27i199 + 0.0) : 0.0))))));
            i = $t0;
            out = $t1;
            continue;
          } else {
            return out;
          }
        }
      });
      return each$27307(0, $B["number->string"](at));
    });
    (queue_row$27272 = function (item, playing) {
      let artist$27310, b$27309, li$27308, x$27i200, x$27i201, x$27i202;
      (li$27308 = make_element$27dom("li"));
      (b$27309 = make_element$27dom("button"));
      set_attribute$21$27dom(b$27309, "type", "button");
      set_attribute$21$27dom(b$27309, "data-item", $B["number->string"](((x$27i200 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i200) ? (x$27i200 + 0.0) : 0.0))))));
      set_attribute$21$27dom(b$27309, "class", (playing ? "remote-row playing" : "remote-row"));
      set_text$21$27dom(b$27309, ((artist$27310 = ((x$27i201 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i201) ? x$27i201 : ($B["number?"](x$27i201) ? $B["number->string"](x$27i201) : "")))), $B["string-append"](((x$27i202 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i202) ? x$27i202 : ($B["number?"](x$27i202) ? $B["number->string"](x$27i202) : ""))), ($B["equal?"](artist$27310, "") ? "" : $B["string-append"](" \xc2\xb7 ", artist$27310)))));
      append$21$27dom(li$27308, b$27309);
      return li$27308;
    });
    (command$27273 = function (name, value) {
      let msg$27i203, msg$27i204, op$27312, position$27313, q$27311;
      if ($B["equal?"](chosen$27253, "")) {
        return false;
      } else {
        (q$27311 = from_queue$27263(screen_of$27where(chosen$27253)));
        (op$27312 = $B["map-ref"](as_queue$27remote, name, false));
        if ((((q$27311) !== false ? op$27312 : false)) !== false) {
          (position$27313 = $B["map-ref"](q$27311, "position", 0));
          (msg$27i203 = $B["map-of"]("type", "queue", "op", op$27312, "queue", $B["map-ref"](q$27311, "queue", 0), "value", ($B["equal?"](name, "back") ? ((position$27313 > 10) ? (position$27313 - 10) : 0) : ($B["equal?"](name, "forward") ? (position$27313 + 30) : value))));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i203));
          } else {
            return false;
          }
        } else {
          (msg$27i204 = $B["map-of"]("type", "control", "target", chosen$27253, "command", name, "value", value));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i204));
          } else {
            return false;
          }
        }
      }
    });
    (seek_value$27274 = function () {
      let n$27314;
      (n$27314 = $B["string->number"](value_of$27dom(seek$27259)));
      if ((n$27314) !== false) {
        return n$27314;
      } else {
        return 0;
      }
    });
    ((handler$27i205 = function (text, m) {
      (queues$27257 = $B["map-set"](queues$27257, $B["map-ref"](m, "id", 0), $B["map-set"](m, "received", now_ms$27page())));
      return render$27269();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue", $B["append"]($B["map-ref"](handlers$27socket, "queue", null), $listFromEnd(handler$27i205)))));
    ((handler$27i208 = function (text, m) {
      let each$27316, l$27315;
      ((l$27315 = $B["map-ref"](m, "targets", $B["vector"]())), (each$27316 = function (i) {
        let msg$27i207, q$27317, x$27i206;
        for (;;) {
          if ((i < $B["vector-length"](l$27315))) {
            (q$27317 = ((x$27i206 = $B["map-ref"]($B["vector-ref"](l$27315, i), "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i206) ? (x$27i206 + 0.0) : 0.0)))));
            (((q$27317 > 0) ? ($B["map-ref"](queues$27257, q$27317, false) === false) : false) ? ((msg$27i207 = $B["map-of"]("type", "queue", "op", "state", "queue", q$27317)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i207)) : false)) : false);
            const $t0 = (i + 1);
            i = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27316(0));
      return render$27269();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "targets", $B["append"]($B["map-ref"](handlers$27socket, "targets", null), $listFromEnd(handler$27i208)))));
    ((handler$27i209 = function (text, m) {
      return render$27269();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i209)))));
    ((handler$27i210 = function (text, s) {
      (states$27256 = $B["map-set"](states$27256, $B["map-ref"](s, "from", ""), s));
      return render$27269();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "state", $B["append"]($B["map-ref"](handlers$27socket, "state", null), $listFromEnd(handler$27i210)))));
    every$27page(1000, function () {
      if ((from_queue$27263(screen_of$27where(chosen$27253))) !== false) {
        return render$27269();
      } else {
        return false;
      }
    });
    on$27dom(tabs$27258, click$27dom, function (e) {
      let b$27318;
      (b$27318 = closest_of$27dom(e, "[data-screen]"));
      if ((b$27318) !== false) {
        (chosen$27253 = data_of$27dom(b$27318, "screen"));
        return render$27269();
      } else {
        return false;
      }
    });
    on$27dom(remote, click$27dom, function (e) {
      let b$27319;
      (b$27319 = closest_of$27dom(e, "[data-command]"));
      if ((b$27319) !== false) {
        return command$27273(data_of$27dom(b$27319, "command"), 0);
      } else {
        return false;
      }
    });
    ((button$27320 = by_id$27dom("remote-list")), ((button$27320) !== false ? on$27dom(button$27320, click$27dom, function (e) {
      (listing$27260 = (listing$27260 === false));
      set_attribute$21$27dom(button$27320, "aria-expanded", (listing$27260 ? "true" : "false"));
      return render$27269();
    }) : false));
    ((list$27321 = by_id$27dom("remote-queue")), ((list$27321) !== false ? on$27dom(list$27321, click$27dom, function (e) {
      let b$27322, msg$27i211, n$27324, q$27323;
      (b$27322 = closest_of$27dom(e, "[data-item]"));
      (q$27323 = queue_of$27262(screen_of$27where(chosen$27253)));
      if ((((b$27322) !== false ? q$27323 : false)) !== false) {
        (msg$27i211 = $B["map-of"]("type", "queue", "op", "jump", "queue", $B["map-ref"](q$27323, "id", 0), "item", ((n$27324 = $B["string->number"](data_of$27dom(b$27322, "item"))), ((n$27324) !== false ? n$27324 : 0))));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i211));
        } else {
          return false;
        }
      } else {
        return false;
      }
    }) : false));
    on$27dom(seek$27259, input$27dom, function (e) {
      let x$27i212, x$27i213;
      (dragging$27254 = true);
      return text$21$27remote("remote-time", $B["string-append"](clock$27clock(((x$27i212 = seek_value$27274()), ($B["number?"](x$27i212) ? (x$27i212 + 0.0) : 0.0))), " / ", clock$27clock(((x$27i213 = $B["map-ref"]($B["map-ref"](states$27256, chosen$27253, $B["map-of"]()), "duration", 0)), ($B["number?"](x$27i213) ? (x$27i213 + 0.0) : 0.0)))));
    });
    on$27dom(seek$27259, change$27dom, function (e) {
      (dragging$27254 = false);
      return command$27273("seek", seek_value$27274());
    });
    return render$27269();
  });
  (bar_player$27bar = false);
  (bar_key$27bar = "hazelflix-bar");
  (bar_wake$21$27bar = function (queue) {
    let r$27i215, r$27i216, r$27i217;
    if ((bar_player$27bar) !== false) {
      (((((r$27i215 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i215))() ? (((r$27i216 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i216))() === queue) : false)) !== false ? false : ((r$27i217 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i217))(queue));
      return true;
    } else {
      return false;
    }
  });
  (nothing$27bar = function () {
    return false;
  });
  (players_start$27bar = function () {
    let bar$27326, close$27dom$27327, film$27i218, film$27i221, handler$27i229, on_load$27i219, on_load$27i222, on_sleep$27i224, on_wake$27i223, screen$27325;
    (screen$27325 = by_id$27dom("player-screen"));
    (bar$27326 = by_id$27dom("music-bar"));
    if ((screen$27325) !== false) {
      return start_player$27player(screen$27325, ((film$27i218 = function (item) {
        return false;
      }), (on_load$27i219 = function (item, p) {
        return false;
      }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", false, false, film$27i218, on_load$27i219, nothing$27bar, nothing$27bar)));
    } else {
      if ((bar$27326) !== false) {
        (bar_player$27bar = start_player$27player(bar$27326, ((film$27i221 = function (item) {
          return false;
        }), (on_load$27i222 = function (item, p) {
          return false;
        }), (on_wake$27i223 = function () {
          let r$27i220;
          set_hidden$21$27dom(bar$27326, false);
          add_class$21$27dom(body$27dom(), "with-bar");
          session_set$21$27page(bar_key$27bar, $B["number->string"](((r$27i220 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i220))()));
          return false;
        }), (on_sleep$27i224 = function () {
          set_hidden$21$27dom(bar$27326, true);
          remove_class$21$27dom(body$27dom(), "with-bar");
          session_remove$21$27page(bar_key$27bar);
          return false;
        }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", true, true, film$27i221, on_load$27i222, on_wake$27i223, on_sleep$27i224))));
        ((close$27dom$27327 = query_in$27dom(bar$27326, "[data-bar-close]")), ((close$27dom$27327) !== false ? on$27dom(close$27dom$27327, click$27dom, function (e) {
          let r$27i225;
          return ((r$27i225 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r$27i225))();
        }) : false));
        (handler$27i229 = function (text, m) {
          let r$27i227, r$27i228, was$27328, x$27i226;
          (was$27328 = ((x$27i226 = $B["string->number"](session_get$27page(bar_key$27bar))), $B["exact"]($B["floor"](($B["number?"](x$27i226) ? (x$27i226 + 0.0) : 0.0)))));
          if ((((was$27328 > 0) ? (((r$27i227 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i227))() === false) : false)) !== false) {
            return ((r$27i228 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i228))(was$27328);
          } else {
            return false;
          }
        });
        return (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i229))));
      } else {
        return false;
      }
    }
  });
  (digits$3f$27bar = function (s, from) {
    let loop$27329;
    if ((from < $B["string-length"](s))) {
      (loop$27329 = function (i) {
        let b$27330;
        for (;;) {
          if ((i === $B["string-length"](s))) {
            return true;
          } else {
            if (((b$27330 = $B["byte-ref"](s, i)), ((b$27330 >= 48) ? (b$27330 <= 57) : false))) {
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return false;
            }
          }
        }
      });
      return loop$27329(from);
    } else {
      return false;
    }
  });
  (site_path$27bar = function (url) {
    let cut$27332, origin$27page$27331;
    (origin$27page$27331 = origin$27page());
    if (($B["string-prefix?"](origin$27page$27331, url) ? $B["string-prefix?"]("/", $B["substring"](url, $B["string-length"](origin$27page$27331), $B["string-length"](url))) : false)) {
      (cut$27332 = function (p, i) {
        let or$27value$27333;
        for (;;) {
          if ((i === $B["string-length"](p))) {
            if (((i > 1) ? $B["string-suffix?"]("/", p) : false)) {
              return $B["substring"](p, 0, (i - 1));
            } else {
              return p;
            }
          } else {
            if (((or$27value$27333 = ($B["byte-ref"](p, i) === 63)), (or$27value$27333 ? or$27value$27333 : ($B["byte-ref"](p, i) === 35)))) {
              const $t0 = $B["substring"](p, 0, i);
              const $t1 = 0;
              p = $t0;
              i = $t1;
              continue;
            } else {
              const $t0 = p;
              const $t1 = (i + 1);
              p = $t0;
              i = $t1;
              continue;
            }
          }
        }
      });
      return cut$27332($B["substring"](url, $B["string-length"](origin$27page$27331), $B["string-length"](url)), 0);
    } else {
      return false;
    }
  });
  (swappable$3f$27bar = function (url) {
    let or$27value$27335, or$27value$27336, or$27value$27337, or$27value$27338, or$27value$27339, or$27value$27340, or$27value$27341, p$27334;
    (p$27334 = site_path$27bar(url));
    if ((p$27334) !== false) {
      (or$27value$27335 = $B["equal?"](p$27334, "/music"));
      if (or$27value$27335) {
        return or$27value$27335;
      } else {
        (or$27value$27336 = $B["equal?"](p$27334, "/music/songs"));
        if (or$27value$27336) {
          return or$27value$27336;
        } else {
          (or$27value$27337 = $B["equal?"](p$27334, "/music/videos"));
          if (or$27value$27337) {
            return or$27value$27337;
          } else {
            (or$27value$27338 = $B["equal?"](p$27334, "/music/artists"));
            if (or$27value$27338) {
              return or$27value$27338;
            } else {
              (or$27value$27339 = $B["equal?"](p$27334, "/music/playlists"));
              if (or$27value$27339) {
                return or$27value$27339;
              } else {
                (or$27value$27340 = ($B["string-prefix?"]("/album/", p$27334) ? digits$3f$27bar(p$27334, 7) : false));
                if ((or$27value$27340) !== false) {
                  return or$27value$27340;
                } else {
                  (or$27value$27341 = ($B["string-prefix?"]("/artist/", p$27334) ? digits$3f$27bar(p$27334, 8) : false));
                  if ((or$27value$27341) !== false) {
                    return or$27value$27341;
                  } else {
                    if ($B["string-prefix?"]("/playlist/", p$27334)) {
                      return digits$3f$27bar(p$27334, 10);
                    } else {
                      return false;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      return false;
    }
  });
  (kept$3f$27bar = function (e) {
    let or$27value$27342, or$27value$27343;
    (or$27value$27342 = $B["equal?"](id_of$27dom(e), "music-bar"));
    if (or$27value$27342) {
      return or$27value$27342;
    } else {
      (or$27value$27343 = $B["equal?"](tag_of$27dom(e), "SCRIPT"));
      if (or$27value$27343) {
        return or$27value$27343;
      } else {
        return $B["equal?"](id_of$27dom(e), "intro");
      }
    }
  });
  (go$27bar = function (url, push) {
    return fetch_text$27fetch(url, function (status, text) {
      let bar$27348, coming$27353, doc$27344, each$27352, each$27354, fresh$27346, fresh_body$27345, here$27347, new_style$27350, now$27351, old_style$27349;
      if ((status === 0)) {
        return go$21$27page(url);
      } else {
        (doc$27344 = read_page$27page(text));
        (fresh_body$27345 = body_of$27dom(doc$27344));
        (fresh$27346 = ((fresh_body$27345) !== false ? first_element_of$27dom(fresh_body$27345) : false));
        (here$27347 = first_element_of$27dom(body$27dom()));
        (bar$27348 = by_id$27dom("music-bar"));
        if ((((fresh$27346) !== false ? ((here$27347) !== false ? ((bar$27348) !== false ? query_in$27dom(doc$27344, "main") : false) : false) : false)) !== false) {
          (old_style$27349 = head_style$27page(this_page$27dom()));
          (new_style$27350 = head_style$27page(doc$27344));
          ((((old_style$27349) !== false ? new_style$27350 : false)) !== false ? set_text$21$27dom(old_style$27349, text_of$27dom(new_style$27350)) : false);
          set_page_title$21$27page(page_title$27page(doc$27344));
          ((now$27351 = children_of$27dom(here$27347)), ((each$27352 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](now$27351))) {
                (kept$3f$27bar($B["vector-ref"](now$27351, i)) ? false : remove$21$27dom($B["vector-ref"](now$27351, i)));
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          }), each$27352(0)));
          ((coming$27353 = children_of$27dom(fresh$27346)), ((each$27354 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](coming$27353))) {
                (kept$3f$27bar($B["vector-ref"](coming$27353, i)) ? false : insert_before$21$27dom(here$27347, import$21$27dom($B["vector-ref"](coming$27353, i)), bar$27348));
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          }), each$27354(0)));
          (push ? push_address$21$27page(url) : false);
          return scroll_to_top$21$27page();
        } else {
          return go$21$27page(url);
        }
      }
    });
  });
  (pages_swap$27bar = function () {
    if ((by_id$27dom("music-bar")) !== false) {
      on_document$27dom(click$27dom, function (e) {
        let a$27355, r$27i214$27i230, url$27356;
        if (((((bar_player$27bar) !== false ? ((r$27i214$27i230 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i214$27i230))() : false)) !== false ? ((default_prevented$3f$27dom(e) === false) ? plain_click$3f$27dom(e) : false) : false)) {
          (a$27355 = closest_of$27dom(e, "a[href]"));
          if ((a$27355) !== false) {
            (url$27356 = link_address$27page(a$27355));
            if (((($B["equal?"](url$27356, "") === false) ? swappable$3f$27bar(url$27356) : false)) !== false) {
              prevent_default$21$27dom(e);
              return go$27bar(url$27356, true);
            } else {
              return false;
            }
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
      return on_window$27page(popstate$27page, function (e) {
        let r$27i214$27i231;
        if ((((((bar_player$27bar) !== false ? ((r$27i214$27i231 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i214$27i231))() : false)) !== false ? swappable$3f$27bar(address$27page()) : false)) !== false) {
          return go$27bar(address$27page(), false);
        } else {
          return reload$21$27page();
        }
      });
    } else {
      return false;
    }
  });
  (send$27music = function (msg) {
    if (((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg)) : false)) {
      return false;
    } else {
      return note$27ui("Not connected to HazelFlix just now: try again in a moment.");
    }
  });
  (ask_where$27music = function (msg, there) {
    let choices;
    (choices = function (l) {
      let t$27358;
      if ($B["null?"](l)) {
        return null;
      } else {
        (t$27358 = $B["car"](l));
        return $B["cons"]($B["cons"]($B["map-ref"](t$27358, "name", ""), function () {
          return send$27music($B["map-set"](msg, "target", $B["map-ref"](t$27358, "id", "")));
        }), choices($B["cdr"](l)));
      }
    });
    return choose$27ui("Play where?", $B["cons"]($B["cons"]("This browser", function () {
      return send$27music(msg);
    }), choices(there)));
  });
  (music_buttons$27music = function () {
    let handler$27i236, handler$27i237;
    on_document$27dom(click$27dom, function (e) {
      let b$27359, msg$27360, n$27357$27i233, n$27357$27i235, s$27i232, s$27i234, there$27361;
      (b$27359 = closest_of$27dom(e, "[data-music]"));
      if ((b$27359) !== false) {
        (msg$27360 = $B["map-of"]("type", "queue", "op", data_of$27dom(b$27359, "music"), "what", data_of$27dom(b$27359, "what"), "id", ((s$27i232 = data_of$27dom(b$27359, "id")), ((n$27357$27i233 = $B["string->number"](s$27i232)), ((n$27357$27i233) !== false ? n$27357$27i233 : 0))), "start", ((s$27i234 = data_of$27dom(b$27359, "start")), ((n$27357$27i235 = $B["string->number"](s$27i234)), ((n$27357$27i235) !== false ? n$27357$27i235 : 0))), "shuffle", $B["equal?"](data_of$27dom(b$27359, "shuffle"), "1"), "next", $B["equal?"](data_of$27dom(b$27359, "next"), "1"), "queue", queue_now$27player));
        (there$27361 = other_screens$27where());
        prevent_default$21$27dom(e);
        if (($B["equal?"](data_of$27dom(b$27359, "music"), "play") ? (($B["null?"](there$27361) === false) ? (dialogs$3f$27dom() ? (by_id$27dom("player-screen") === false) : false) : false) : false)) {
          return ask_where$27music(msg$27360, there$27361);
        } else {
          return send$27music(msg$27360);
        }
      } else {
        return false;
      }
    });
    ((handler$27i236 = function (text, m) {
      let name$27362;
      if ((by_id$27dom("player-screen")) !== false) {
        return false;
      } else {
        if (($B["map-ref"](m, "elsewhere", false)) !== false) {
          return note$27ui(((name$27362 = $B["map-ref"](m, "name", "")), ($B["equal?"](name$27362, "") ? "Playing on the player that's open." : $B["string-append"]("Playing on ", name$27362, "."))));
        } else {
          if (bar_wake$21$27bar($B["map-ref"](m, "queue", 0))) {
            return false;
          } else {
            return go$21$27page($B["string-append"]("/music/player?queue=", $B["number->string"]($B["map-ref"](m, "queue", 0))));
          }
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queued", $B["append"]($B["map-ref"](handlers$27socket, "queued", null), $listFromEnd(handler$27i236)))));
    (handler$27i237 = function (text, m) {
      let n$27363;
      (n$27363 = $B["map-ref"](m, "n", 1));
      return note$27ui(((n$27363 === 1) ? "Added to the queue." : $B["string-append"]($B["number->string"](n$27363), " added to the queue.")));
    });
    return (handlers$27socket = $B["map-set"](handlers$27socket, "added", $B["append"]($B["map-ref"](handlers$27socket, "added", null), $listFromEnd(handler$27i237))));
  });
  (piece$27photos = 67108864);
  (at_once$27photos = 2);
  (quiet_ms$27photos = 30000);
  (tries$27photos = 3);
  (each_of$27photos = function (l, f) {
    for (;;) {
      if ($B["null?"](l)) {
        return true;
      } else {
        f($B["car"](l));
        const $t0 = $B["cdr"](l);
        const $t1 = f;
        l = $t0;
        f = $t1;
        continue;
      }
    }
  });
  (photos_page$27photos = function () {
    let chooser$27367, finished$27375, going$27370, handler$27i251, line_for$27372, lines$27368, made$27371, next$27374, queue$27369, send_file$27376, sending$3f$27373, watch$27377;
    (chooser$27367 = by_id$27dom("photo-files"));
    (lines$27368 = by_id$27dom("photo-uploads"));
    (queue$27369 = null);
    (going$27370 = 0);
    (made$27371 = 0);
    (line_for$27372 = function (name) {
      let l$27378;
      (l$27378 = make_element$27dom("div"));
      set_text$21$27dom(l$27378, $B["string-append"](name, ": waiting"));
      append$21$27dom(lines$27368, l$27378);
      return l$27378;
    });
    (sending$3f$27373 = function () {
      let or$27value$27379;
      (or$27value$27379 = (going$27370 > 0));
      if (or$27value$27379) {
        return or$27value$27379;
      } else {
        return $B["pair?"](queue$27369);
      }
    });
    (next$27374 = function () {
      let f$27380;
      for (;;) {
        if (((going$27370 < at_once$27photos) ? $B["pair?"](queue$27369) : false)) {
          (f$27380 = $B["car"](queue$27369));
          (queue$27369 = $B["cdr"](queue$27369));
          (going$27370 = (going$27370 + 1));
          send_file$27376(f$27380);
          continue;
        } else {
          return false;
        }
      }
    });
    (finished$27375 = function () {
      (going$27370 = (going$27370 - 1));
      return next$27374();
    });
    (send_file$27376 = function (f) {
      let began$27385, failed$27386, from$27387, id$27383, line$27384, name$27381, size$27382;
      (name$27381 = file_name$27fetch(f));
      (size$27382 = file_size$27fetch(f));
      (id$27383 = $B["random-hex"](16));
      (line$27384 = line_for$27372(name$27381));
      (began$27385 = now_ms$27page());
      (failed$27386 = function (why) {
        set_text$21$27dom(line$27384, $B["string-append"](name$27381, ": ", why));
        set_style$21$27dom(line$27384, "color", "#f0b446");
        return finished$27375();
      });
      (from$27387 = function (at, tried) {
        let asked$27389, end$27388, id$27i238, most$27390, name$27i239, size$27i240;
        (end$27388 = (((at + piece$27photos) > size$27382) ? size$27382 : (at + piece$27photos)));
        (asked$27389 = now_ms$27page());
        (most$27390 = 0);
        return post_piece_watched$21$27fetch(((id$27i238 = id$27383), (name$27i239 = name$27381), (size$27i240 = size$27382), $B["string-append"]("/photos/upload?id=", id$27i238, "&name=", encode_component$27page(name$27i239), "&size=", $B["number->string"](size$27i240))), f, at, end$27388, quiet_ms$27photos, function (sent) {
          let bytes$27i241, mb$27366$27i243, ms$27i242;
          ((sent > most$27390) ? (most$27390 = sent) : false);
          return set_text$21$27dom(line$27384, $B["string-append"](name$27381, ": ", $B["number->string"]($B["quotient"]((100 * (at + sent)), size$27382)), "%", ((bytes$27i241 = (at + sent)), (ms$27i242 = (now_ms$27page() - began$27385)), ((ms$27i242 < 500.0) ? "" : ((mb$27366$27i243 = (((bytes$27i241 + 0.0) / 1048576.0) / (ms$27i242 / 1000.0))), $B["string-append"](", ", $realText(($B["round"]((mb$27366$27i243 * 10.0)) / 10.0)), " MB/s"))))));
        }, function (status, body$27dom) {
          let bytes$27i248, m$27364$27i244, m$27364$27i246, mb$27366$27i250, ms$27i249, v$27365$27i245, v$27365$27i247, why$27391;
          post_form$21$27fetch("/photos/log", $B["string-append"]("line=", encode_component$27page($B["string-append"]("page ", $B["substring"](id$27383, 0, 6), " at ", $B["number->string"](at), "-", $B["number->string"](end$27388), " try ", $B["number->string"](tried), ": status ", $B["number->string"](status), " after ", $B["number->string"]($B["exact"]($B["round"]((now_ms$27page() - asked$27389)))), " ms, ", $B["number->string"](most$27390), " bytes seen going, ", (($B["string-length"](body$27dom) > 60) ? $B["substring"](body$27dom, 0, 60) : body$27dom)))));
          if ((((status <= 0) ? (tried < tries$27photos) : false)) !== false) {
            set_text$21$27dom(line$27384, $B["string-append"](name$27381, ": ", ((status === -1) ? $B["string-append"]("the phone wouldn't hand it over (", body$27dom, "), trying again") : "stalled, trying again")));
            return after$27page(2000, function () {
              return from$27387(at, (tried + 1));
            });
          } else {
            if ((status === -1)) {
              return failed$27386($B["string-append"]("the phone wouldn't hand it over (", body$27dom, ")"));
            } else {
              if (((status === 200) === false)) {
                return failed$27386(((why$27391 = ((m$27364$27i244 = $B["json-parse"](body$27dom, false)), ($B["map?"](m$27364$27i244) ? ((v$27365$27i245 = $B["map-ref"](m$27364$27i244, "error", "")), ($B["string?"](v$27365$27i245) ? v$27365$27i245 : "")) : ""))), ($B["equal?"](why$27391, "") ? "couldn't be sent" : why$27391)));
              } else {
                if ((end$27388 < size$27382)) {
                  return from$27387(end$27388, 1);
                } else {
                  if ($B["equal?"](((m$27364$27i246 = $B["json-parse"](body$27dom, false)), ($B["map?"](m$27364$27i246) ? ((v$27365$27i247 = $B["map-ref"](m$27364$27i246, "state", "")), ($B["string?"](v$27365$27i247) ? v$27365$27i247 : "")) : "")), "known")) {
                    set_text$21$27dom(line$27384, $B["string-append"](name$27381, ": already here"));
                    return finished$27375();
                  } else {
                    (made$27371 = (made$27371 + 1));
                    set_text$21$27dom(line$27384, $B["string-append"](name$27381, ": sent", ((bytes$27i248 = size$27382), (ms$27i249 = (now_ms$27page() - began$27385)), ((ms$27i249 < 500.0) ? "" : ((mb$27366$27i250 = (((bytes$27i248 + 0.0) / 1048576.0) / (ms$27i249 / 1000.0))), $B["string-append"](", ", $realText(($B["round"]((mb$27366$27i250 * 10.0)) / 10.0)), " MB/s")))), ", being made ready"));
                    return finished$27375();
                  }
                }
              }
            }
          }
        });
      });
      if ((size$27382 === 0)) {
        return failed$27386("empty");
      } else {
        if ((size$27382 > piece$27photos)) {
          return failed$27386("too large: 64 MB at most");
        } else {
          return from$27387(0, 1);
        }
      }
    });
    if ((chooser$27367 === false)) {
      return false;
    } else {
      (watch$27377 = function (input$27dom) {
        return on$27dom(input$27dom, change$27dom, function (e) {
          (queue$27369 = $B["append"](queue$27369, $B["vector->list"](chosen_files$27fetch(input$27dom))));
          watch$27377(file_input_again$21$27fetch(input$27dom));
          return next$27374();
        });
      });
      watch$27377(chooser$27367);
      ((handler$27i251 = function (text, msg) {
        let or$27value$27392;
        if (((((or$27value$27392 = (made$27371 > 0)), (or$27value$27392 ? or$27value$27392 : query$27dom("[data-photos-making]")))) !== false ? (sending$3f$27373() === false) : false)) {
          return reload$21$27page();
        } else {
          return false;
        }
      }), (handlers$27socket = $B["map-set"](handlers$27socket, "photos", $B["append"]($B["map-ref"](handlers$27socket, "photos", null), $listFromEnd(handler$27i251)))));
      return photo_dialog$27photos();
    }
  });
  (place_pin$27photos = function (place) {
    let pin$27393;
    (pin$27393 = by_id$27dom("photo-dialog-place"));
    if ((pin$27393) !== false) {
      set_attribute$21$27dom(pin$27393, "data-place", place);
      return set_hidden$21$27dom(pin$27393, $B["equal?"](place, ""));
    } else {
      return false;
    }
  });
  (photo_dialog$27photos = function () {
    let cancel$27397, d$27394, delete$27398, pin$27396;
    (d$27394 = by_id$27dom("photo-dialog"));
    if (((d$27394) !== false ? dialogs$3f$27dom() : false)) {
      each_of$27photos($B["vector->list"](query_all$27dom("[data-photo]")), function (card) {
        return on$27dom(card, click$27dom, function (e) {
          let id$27395;
          if (plain_click$3f$27dom(e)) {
            (id$27395 = data_of$27dom(card, "photo"));
            prevent_default$21$27dom(e);
            set_attribute$21$27dom(by_id$27dom("photo-dialog-img"), "src", $B["string-append"]("/photo/", id$27395));
            set_text$21$27dom(by_id$27dom("photo-dialog-date"), data_of$27dom(card, "date"));
            set_field$21$27dom(by_id$27dom("photo-dialog-caption"), data_of$27dom(card, "caption"));
            place_pin$27photos(data_of$27dom(card, "place"));
            set_attribute$21$27dom(by_id$27dom("photo-dialog-form"), "action", $B["string-append"]("/photos/", id$27395));
            return show_modal$21$27dom(d$27394);
          } else {
            return false;
          }
        });
      });
      ((pin$27396 = by_id$27dom("photo-dialog-place")), ((pin$27396) !== false ? (place_pin$27photos(data_of$27dom(pin$27396, "place")), on$27dom(pin$27396, click$27dom, function (e) {
        set_field$21$27dom(by_id$27dom("photo-dialog-caption"), data_of$27dom(pin$27396, "place"));
        return focus$21$27dom(by_id$27dom("photo-dialog-caption"));
      })) : false));
      ((cancel$27397 = query$27dom("[data-photo-cancel]")), (delete$27398 = query$27dom("[data-photo-delete]")), ((cancel$27397) !== false ? on$27dom(cancel$27397, click$27dom, function (e) {
        prevent_default$21$27dom(e);
        return close_dialog$21$27dom(d$27394);
      }) : false), ((delete$27398) !== false ? on$27dom(delete$27398, click$27dom, function (e) {
        if (confirmed$3f$27page("Delete this photo? Its original goes too.")) {
          return false;
        } else {
          return prevent_default$21$27dom(e);
        }
      }) : false));
      return on$27dom(d$27394, click$27dom, function (e) {
        if ((closest_of$27dom(e, "#photo-dialog img, #photo-dialog form")) !== false) {
          return false;
        } else {
          return close_dialog$21$27dom(d$27394);
        }
      });
    } else {
      return false;
    }
  });
  (shown_ms$27saver = 10000);
  (nth$27saver = function (l, i) {
    for (;;) {
      if ((i === 0)) {
        return $B["car"](l);
      } else {
        const $t0 = $B["cdr"](l);
        const $t1 = (i - 1);
        l = $t0;
        i = $t1;
        continue;
      }
    }
  });
  (without$27saver = function (l, i) {
    if ((i === 0)) {
      return $B["cdr"](l);
    } else {
      return $B["cons"]($B["car"](l), without$27saver($B["cdr"](l), (i - 1)));
    }
  });
  (saver_runs$27saver = function () {
    let end$27410, front$27403, handler$27i258, handler$27i259, load_photos$27411, next_photo$27406, order$27402, photos$27401, saver$27399, show$27408, showing$27405, start$27409, texts$27407, timer$27404, wait$27400;
    (saver$27399 = by_id$27dom("saver"));
    (wait$27400 = by_id$27dom("ready-wait"));
    (photos$27401 = $B["vector"]());
    (order$27402 = null);
    (front$27403 = false);
    (timer$27404 = 0);
    (showing$27405 = false);
    (next_photo$27406 = function () {
      let i$27412, p$27413;
      ($B["null?"](order$27402) ? (order$27402 = $B["vector->list"](photos$27401)) : false);
      (i$27412 = $B["exact"]($B["floor"]((random$27page() * $B["length"](order$27402)))));
      (p$27413 = nth$27saver(order$27402, i$27412));
      (order$27402 = without$27saver(order$27402, i$27412));
      return p$27413;
    });
    (texts$27407 = function (p) {
      set_text$21$27dom(by_id$27dom("saver-caption"), $B["map-ref"](p, "caption", ""));
      return set_text$21$27dom(by_id$27dom("saver-date"), $B["map-ref"](p, "date", ""));
    });
    (show$27408 = function (p) {
      let back$27417, begin_moving$27422, coming$27414, from$27420, going$27415, img$27416, scale$27i252, scale$27i255, to$27421, url$27418, x$27i253, x$27i256, y$27i254, y$27i257, zoom_in$27419;
      (coming$27414 = by_id$27dom(($B["equal?"](front$27403, "saver-a") ? "saver-b" : "saver-a")));
      (going$27415 = ((front$27403) !== false ? by_id$27dom(front$27403) : false));
      (img$27416 = query_in$27dom(coming$27414, "img"));
      (back$27417 = query_in$27dom(coming$27414, ".saver-back"));
      (url$27418 = $B["string-append"]("/photo/", $B["number->string"]($B["map-ref"](p, "id", 0))));
      (zoom_in$27419 = (random$27page() < 0.5));
      (from$27420 = ((scale$27i252 = (zoom_in$27419 ? 1.0 : 1.1000000000000001)), (x$27i253 = (-2.0 + ((2.0 - -2.0) * random$27page()))), (y$27i254 = (-2.0 + ((2.0 - -2.0) * random$27page()))), $B["string-append"]("scale(", $realText(scale$27i252), ") translate(", $B["string-append"]($realText(($B["round"]((x$27i253 * 100.0)) / 100.0)), "%"), ", ", $B["string-append"]($realText(($B["round"]((y$27i254 * 100.0)) / 100.0)), "%"), ")")));
      (to$27421 = ((scale$27i255 = (zoom_in$27419 ? 1.1000000000000001 : 1.0)), (x$27i256 = (-2.0 + ((2.0 - -2.0) * random$27page()))), (y$27i257 = (-2.0 + ((2.0 - -2.0) * random$27page()))), $B["string-append"]("scale(", $realText(scale$27i255), ") translate(", $B["string-append"]($realText(($B["round"]((x$27i256 * 100.0)) / 100.0)), "%"), ", ", $B["string-append"]($realText(($B["round"]((y$27i257 * 100.0)) / 100.0)), "%"), ")")));
      (begin_moving$27422 = function () {
        set_style$21$27dom(coming$27414, "transition", "none");
        set_style$21$27dom(coming$27414, "transform", from$27420);
        set_style$21$27dom(coming$27414, "opacity", "0");
        after$27page(50, function () {
          set_style$21$27dom(coming$27414, "transition", "transform 11.5s linear, opacity 1.5s ease");
          set_style$21$27dom(coming$27414, "transform", to$27421);
          set_style$21$27dom(coming$27414, "opacity", "1");
          texts$27407(p);
          if ((going$27415) !== false) {
            return set_style$21$27dom(going$27415, "opacity", "0");
          } else {
            return false;
          }
        });
        (front$27403 = id_of$27dom(coming$27414));
        return (timer$27404 = after$27page(shown_ms$27saver, function () {
          if (showing$27405) {
            return show$27408(next_photo$27406());
          } else {
            return false;
          }
        }));
      });
      on_once$27dom(img$27416, load$27dom, function (e) {
        if (showing$27405) {
          return begin_moving$27422();
        } else {
          return false;
        }
      });
      set_style$21$27dom(back$27417, "background-image", $B["string-append"]("url(", url$27418, ")"));
      return set_attribute$21$27dom(img$27416, "src", url$27418);
    });
    (start$27409 = function () {
      (showing$27405 = true);
      set_text$21$27dom(by_id$27dom("saver-name"), $B["map-ref"](self$27socket, "name", ""));
      set_hidden$21$27dom(saver$27399, false);
      return show$27408(next_photo$27406());
    });
    (end$27410 = function () {
      (showing$27405 = false);
      cancel_timer$21$27page(timer$27404);
      return set_hidden$21$27dom(saver$27399, true);
    });
    (load_photos$27411 = function () {
      return fetch_text$27fetch("/photos.json", function (status, body$27dom) {
        let l$27423;
        (l$27423 = ((status === 200) ? $B["json-parse"](body$27dom, false) : false));
        if ($B["vector?"](l$27423)) {
          (photos$27401 = l$27423);
          (order$27402 = null);
          if ((showing$27405 ? ($B["vector-length"](l$27423) === 0) : false)) {
            return end$27410();
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
    });
    if ((((saver$27399) !== false ? wait$27400 : false)) !== false) {
      load_photos$27411();
      ((handler$27i258 = function (text, m) {
        return load_photos$27411();
      }), (handlers$27socket = $B["map-set"](handlers$27socket, "photos", $B["append"]($B["map-ref"](handlers$27socket, "photos", null), $listFromEnd(handler$27i258)))));
      ((handler$27i259 = function (text, m) {
        return set_text$21$27dom(by_id$27dom("saver-name"), $B["map-ref"](self$27socket, "name", ""));
      }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i259)))));
      return every$27page(1000, function () {
        let want$27424;
        (want$27424 = ((hidden$3f$27dom(wait$27400) === false) ? ($B["vector-length"](photos$27401) > 0) : false));
        if ((want$27424 ? (showing$27405 === false) : false)) {
          return start$27409();
        } else {
          if ((showing$27405 ? (want$27424 === false) : false)) {
            return end$27410();
          } else {
            return false;
          }
        }
      });
    } else {
      return false;
    }
  });
  (full$3f$27keypad = function (field, pad) {
    let n$27425;
    (n$27425 = $B["string->number"](data_of$27dom(pad, "length")));
    if ((n$27425) !== false) {
      if ((n$27425 > 0)) {
        return ($B["string-length"](value_of$27dom(field)) >= n$27425);
      } else {
        return false;
      }
    } else {
      return false;
    }
  });
  (keypads_work$27keypad = function () {
    let field$27427, pad$27426;
    (pad$27426 = query$27dom("[data-keypad]"));
    (field$27427 = query$27dom("input[data-code]"));
    if ((((pad$27426) !== false ? field$27427 : false)) !== false) {
      on_document$27dom(click$27dom, function (e) {
        let k$27429, key$27428, now$27430;
        (key$27428 = closest_of$27dom(e, "[data-key]"));
        if ((key$27428) !== false) {
          (k$27429 = data_of$27dom(key$27428, "key"));
          (now$27430 = value_of$27dom(field$27427));
          prevent_default$21$27dom(e);
          ($B["equal?"](k$27429, "back") ? set_field$21$27dom(field$27427, (($B["string-length"](now$27430) > 0) ? $B["substring"](now$27430, 0, ($B["string-length"](now$27430) - 1)) : "")) : (($B["string-length"](now$27430) < 12) ? set_field$21$27dom(field$27427, $B["string-append"](now$27430, k$27429)) : false));
          if (full$3f$27keypad(field$27427, pad$27426)) {
            return submit_form$21$27dom(field$27427);
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
      return on$27dom(field$27427, input$27dom, function (e) {
        if (full$3f$27keypad(field$27427, pad$27426)) {
          return submit_form$21$27dom(field$27427);
        } else {
          return false;
        }
      });
    } else {
      return false;
    }
  });
  (frame_step$27picker = 0.041666666666666664);
  (each_in$27picker = function (v, f) {
    let loop$27431;
    (loop$27431 = function (i) {
      for (;;) {
        if ((i < $B["vector-length"](v))) {
          f($B["vector-ref"](v, i));
          const $t0 = (i + 1);
          i = $t0;
          continue;
        } else {
          return true;
        }
      }
    });
    return loop$27431(0);
  });
  (clamp$27picker = function (x, lo, hi) {
    if ((x < lo)) {
      return lo;
    } else {
      if ((x > hi)) {
        return hi;
      } else {
        return x;
      }
    }
  });
  (time_text$27picker = function (t) {
    let hours$27433, minutes$27434, n$27i260, n$27i261, n$27i262, s$27432, seconds$27435;
    const $c1 = $B["floor"](t);
    if (!Number.isInteger($c1)) throw $notInteger;
    (s$27432 = $c1);
    (hours$27433 = $B["quotient"](s$27432, 3600));
    (minutes$27434 = $B["quotient"]($B["remainder"](s$27432, 3600), 60));
    (seconds$27435 = $B["remainder"](s$27432, 60));
    if ((hours$27433 > 0)) {
      return $B["string-append"]($B["number->string"](hours$27433), ":", ((n$27i260 = minutes$27434), ((n$27i260 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i260)) : $B["number->string"](n$27i260))), ":", ((n$27i261 = seconds$27435), ((n$27i261 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i261)) : $B["number->string"](n$27i261))));
    } else {
      return $B["string-append"]($B["number->string"](minutes$27434), ":", ((n$27i262 = seconds$27435), ((n$27i262 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i262)) : $B["number->string"](n$27i262))));
    }
  });
  (number_of$27picker = function (text, fallback) {
    let n$27436;
    (n$27436 = $B["string->number"](text));
    if ((n$27436) !== false) {
      return (n$27436 + 0.0);
    } else {
      return fallback;
    }
  });
  (pickers_work$27picker = function () {
    return each_in$27picker(query_all$27dom("[data-picker]"), picker_work$27picker);
  });
  (picker_work$27picker = function (p) {
    let aspect$27455, box$27438, choose$27470, dragging$27456, draw$27466, duration$27450, fh$27454, file$27449, fit$27467, form$27442, frame$27448, frame_h$27464, frame_w$27463, from_x$27457, from_y$27458, fw$27453, fx$27451, fy$27452, go_to$27469, handle$27439, has_video$27445, height_for$27465, label$27441, n$27436$27i264, n$27436$27i266, now$27462, picture$27447, play_button$27444, scrub$27440, set_button$27443, show_time$27468, stage$27437, start_w$27461, start_x$27459, start_y$27460, text$27i263, text$27i265, video$27446;
    (stage$27437 = query_in$27dom(p, "[data-p-stage]"));
    (box$27438 = query_in$27dom(p, "[data-p-box]"));
    (handle$27439 = query_in$27dom(p, "[data-p-handle]"));
    (scrub$27440 = query_in$27dom(p, "[data-p-scrub]"));
    (label$27441 = query_in$27dom(p, "[data-p-time]"));
    (form$27442 = query_in$27dom(p, "[data-p-form]"));
    (set_button$27443 = query_in$27dom(p, "[data-p-set]"));
    (play_button$27444 = query_in$27dom(p, "[data-p-play]"));
    (has_video$27445 = ((query_in$27dom(p, "video")) !== false ? true : false));
    (video$27446 = (has_video$27445 ? media_in$27media(p, "video") : false));
    (picture$27447 = query_in$27dom(p, "img[data-p-frame]"));
    (frame$27448 = (has_video$27445 ? query_in$27dom(p, "video") : picture$27447));
    (file$27449 = data_of$27dom(p, "file"));
    (duration$27450 = ((text$27i263 = data_of$27dom(p, "duration")), ((n$27436$27i264 = $B["string->number"](text$27i263)), ((n$27436$27i264) !== false ? (n$27436$27i264 + 0.0) : 0.0))));
    (fx$27451 = 0.0);
    (fy$27452 = 0.0);
    (fw$27453 = 1.0);
    (fh$27454 = 1.0);
    (aspect$27455 = 0.66666666666666663);
    (dragging$27456 = "");
    (from_x$27457 = 0.0);
    (from_y$27458 = 0.0);
    (start_x$27459 = 0.0);
    (start_y$27460 = 0.0);
    (start_w$27461 = 0.0);
    (now$27462 = ((text$27i265 = ((scrub$27440) !== false ? value_of$27dom(scrub$27440) : "0")), ((n$27436$27i266 = $B["string->number"](text$27i265)), ((n$27436$27i266) !== false ? (n$27436$27i266 + 0.0) : 0.0))));
    (frame_w$27463 = function () {
      let r$27471;
      (r$27471 = rect_of$27dom(frame$27448));
      return $B["vector-ref"](r$27471, 2);
    });
    (frame_h$27464 = function () {
      let r$27472;
      (r$27472 = rect_of$27dom(frame$27448));
      return $B["vector-ref"](r$27472, 3);
    });
    (height_for$27465 = function (w) {
      let H$27474, W$27473, or$27value$27475;
      (W$27473 = frame_w$27463());
      (H$27474 = frame_h$27464());
      if (((or$27value$27475 = (W$27473 <= 0.0)), (or$27value$27475 ? or$27value$27475 : (H$27474 <= 0.0)))) {
        return w;
      } else {
        return ((w * W$27473) / (aspect$27455 * H$27474));
      }
    });
    (draw$27466 = function () {
      let H$27477, W$27476;
      (W$27476 = frame_w$27463());
      (H$27477 = frame_h$27464());
      if (((W$27476 > 0.0) ? (H$27477 > 0.0) : false)) {
        set_style$21$27dom(box$27438, "left", $B["string-append"]($B["number->string"]((fx$27451 * W$27476)), "px"));
        set_style$21$27dom(box$27438, "top", $B["string-append"]($B["number->string"]((fy$27452 * H$27477)), "px"));
        set_style$21$27dom(box$27438, "width", $B["string-append"]($B["number->string"]((fw$27453 * W$27476)), "px"));
        set_style$21$27dom(box$27438, "height", $B["string-append"]($B["number->string"]((fh$27454 * H$27477)), "px"));
        return set_hidden$21$27dom(box$27438, false);
      } else {
        return false;
      }
    });
    (fit$27467 = function () {
      let h1$27479, h2$27481, w1$27478, w2$27480;
      (w1$27478 = 0.90000000000000002);
      (h1$27479 = height_for$27465(w1$27478));
      (w2$27480 = ((h1$27479 > 0.90000000000000002) ? (w1$27478 * (0.90000000000000002 / h1$27479)) : w1$27478));
      (h2$27481 = height_for$27465(w2$27480));
      (fw$27453 = w2$27480);
      (fh$27454 = h2$27481);
      (fx$27451 = ((1.0 - w2$27480) / 2.0));
      (fy$27452 = ((1.0 - h2$27481) / 2.0));
      return draw$27466();
    });
    (show_time$27468 = function (t) {
      (now$27462 = t);
      ((scrub$27440) !== false ? set_field$21$27dom(scrub$27440, $realText(t)) : false);
      if ((label$27441) !== false) {
        return set_text$21$27dom(label$27441, time_text$27picker(t));
      } else {
        return false;
      }
    });
    (go_to$27469 = function (t) {
      let t2$27482;
      (t2$27482 = clamp$27picker(t, 0.0, ((duration$27450 > 0.0) ? duration$27450 : t)));
      show_time$27468(t2$27482);
      if (has_video$27445) {
        return seek$21$27media(video$27446, t2$27482);
      } else {
        if ((picture$27447) !== false) {
          return set_attribute$21$27dom(picture$27447, "src", $B["string-append"]("/edit/", file$27449, "/frame?t=", $realText(t2$27482)));
        } else {
          return false;
        }
      }
    });
    (choose$27470 = function (radio) {
      let n$27436$27i268, text$27i267;
      (aspect$27455 = ((text$27i267 = data_of$27dom(radio, "aspect")), ((n$27436$27i268 = $B["string->number"](text$27i267)), ((n$27436$27i268) !== false ? (n$27436$27i268 + 0.0) : 0.66666666666666663))));
      ((set_button$27443) !== false ? set_text$21$27dom(set_button$27443, $B["string-append"]("Set ", data_of$27dom(radio, "label"))) : false);
      return fit$27467();
    });
    if ((((stage$27437) !== false ? ((box$27438) !== false ? ((handle$27439) !== false ? ((frame$27448) !== false ? form$27442 : false) : false) : false) : false)) !== false) {
      each_in$27picker(query_all_in$27dom(p, "input[name=\"which\"]"), function (radio) {
        (checked$3f$27dom(radio) ? choose$27470(radio) : false);
        return on$27dom(radio, change$27dom, function (e) {
          return choose$27470(radio);
        });
      });
      on$27dom(frame$27448, (has_video$27445 ? loadedmetadata$27media : load$27dom), function (e) {
        return fit$27467();
      });
      on_window$27page(resize$27page, function (e) {
        return draw$27466();
      });
      on$27dom(box$27438, pointerdown$27dom, function (e) {
        prevent_default$21$27dom(e);
        capture_pointer$21$27dom(box$27438, e);
        (dragging$27456 = ((closest_of$27dom(e, "[data-p-handle]")) !== false ? "size" : "move"));
        (from_x$27457 = pointer_x$27dom(e));
        (from_y$27458 = pointer_y$27dom(e));
        (start_x$27459 = fx$27451);
        (start_y$27460 = fy$27452);
        return (start_w$27461 = fw$27453);
      });
      on_document$27dom(pointermove$27dom, function (e) {
        let dx$27483, dy$27484, hh$27487, most_w$27485, w$27486, w2$27488;
        if ($B["equal?"](dragging$27456, "")) {
          return false;
        } else {
          (dx$27483 = ((pointer_x$27dom(e) - from_x$27457) / frame_w$27463()));
          (dy$27484 = ((pointer_y$27dom(e) - from_y$27458) / frame_h$27464()));
          ($B["equal?"](dragging$27456, "move") ? ((fx$27451 = clamp$27picker((start_x$27459 + dx$27483), 0.0, (1.0 - fw$27453))), (fy$27452 = clamp$27picker((start_y$27460 + dy$27484), 0.0, (1.0 - fh$27454)))) : ((most_w$27485 = (1.0 - fx$27451)), (w$27486 = clamp$27picker((start_w$27461 + dx$27483), 0.050000000000000003, most_w$27485)), (hh$27487 = height_for$27465(w$27486)), (w2$27488 = (((fy$27452 + hh$27487) > 1.0) ? (w$27486 * ((1.0 - fy$27452) / hh$27487)) : w$27486)), (fw$27453 = w2$27488), (fh$27454 = height_for$27465(w2$27488))));
          return draw$27466();
        }
      });
      on_document$27dom(pointerup$27dom, function (e) {
        return (dragging$27456 = "");
      });
      ((scrub$27440) !== false ? on$27dom(scrub$27440, input$27dom, function (e) {
        if (has_video$27445) {
          return go_to$27469(number_of$27picker(value_of$27dom(scrub$27440), now$27462));
        } else {
          return show_time$27468(number_of$27picker(value_of$27dom(scrub$27440), now$27462));
        }
      }) : false);
      (((scrub$27440) !== false ? (has_video$27445 === false) : false) ? on$27dom(scrub$27440, change$27dom, function (e) {
        return go_to$27469(number_of$27picker(value_of$27dom(scrub$27440), now$27462));
      }) : false);
      each_in$27picker(query_all_in$27dom(p, "[data-p-step]"), function (b) {
        return on$27dom(b, click$27dom, function (e) {
          let n$27436$27i270, text$27i269;
          (has_video$27445 ? pause$21$27media(video$27446) : false);
          ((play_button$27444) !== false ? set_text$21$27dom(play_button$27444, "Play") : false);
          return go_to$27469(((has_video$27445 ? media_time$27media(video$27446) : now$27462) + (frame_step$27picker * ((text$27i269 = data_of$27dom(b, "p-step")), ((n$27436$27i270 = $B["string->number"](text$27i269)), ((n$27436$27i270) !== false ? (n$27436$27i270 + 0.0) : 1.0))))));
        });
      });
      (((has_video$27445 ? play_button$27444 : false)) !== false ? (on$27dom(play_button$27444, click$27dom, function (e) {
        if (media_paused$3f$27media(video$27446)) {
          play$21$27media(video$27446);
          return set_text$21$27dom(play_button$27444, "Pause");
        } else {
          pause$21$27media(video$27446);
          return set_text$21$27dom(play_button$27444, "Play");
        }
      }), on$27dom(video$27446, timeupdate$27media, function (e) {
        return show_time$27468(media_time$27media(video$27446));
      }), on$27dom(video$27446, loadedmetadata$27media, function (e) {
        return seek$21$27media(video$27446, now$27462);
      })) : false);
      on$27dom(form$27442, submit$27dom, function (e) {
        let t$27489;
        (t$27489 = (has_video$27445 ? media_time$27media(video$27446) : now$27462));
        set_field$21$27dom(query_in$27dom(form$27442, "input[name=\"t\"]"), $B["number->string"](t$27489));
        set_field$21$27dom(query_in$27dom(form$27442, "input[name=\"x\"]"), $B["number->string"](fx$27451));
        set_field$21$27dom(query_in$27dom(form$27442, "input[name=\"y\"]"), $B["number->string"](fy$27452));
        set_field$21$27dom(query_in$27dom(form$27442, "input[name=\"w\"]"), $B["number->string"](fw$27453));
        return set_field$21$27dom(query_in$27dom(form$27442, "input[name=\"h\"]"), $B["number->string"](fh$27454));
      });
      if ((frame_w$27463() > 0.0)) {
        return fit$27467();
      } else {
        return false;
      }
    } else {
      return false;
    }
  });
  connect$27socket();
  intro_plays$27intro();
  film_back$27back();
  playlists_add$27playlist();
  pop_out$27playlist();
  film_plays$27film();
  play_where$27where();
  ready_to_play$27ready();
  remote_controls$27remote();
  music_buttons$27music();
  players_start$27bar();
  pages_swap$27bar();
  search_as_typed$27search();
  filters_apply$27search();
  converting_refreshes$27search();
  photos_page$27photos();
  saver_runs$27saver();
  keypads_work$27keypad();
  pickers_work$27picker();
});
