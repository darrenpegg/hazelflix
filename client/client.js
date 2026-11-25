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
function $theReal(x) { return typeof x === "number" ? x : $trap("wrong type: not a real"); }
// the boxed types' (#1175)
function $theString(x) { return typeof x === "string" ? x : $trap("wrong type: not a string"); }
function $theList(x) { return x === null || x instanceof Pair ? x : $trap("wrong type: not a list"); }
function $theVector(x) { return Array.isArray(x) ? x : $trap("wrong type: not a vector"); }
function $theMap(x) { return x instanceof Map ? x : $trap("wrong type: not a map"); }
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
const $build = { version: "0.3.2391+c6bc7d15.dirty", commit: "c6bc7d15", branch: "main" };

// the program
$run(() => {
  let add_class$21$27dom, address$27page, after$27page, again$27intro, alert$21$27page, append$21$27dom, as_queue$27remote, ask$27page, ask_where$27music, ask_where$27where, ask_which$27where, asked$27where, asked_href$27where, at_once$27photos, attribute_of$27dom, audio_close$21$27audio, audio_context$27audio, audio_now$27audio, audio_resume$21$27audio, audio_running$3f$27audio, back$21$27page, bar_key$27bar, bar_player$27bar, bar_wake$21$27bar, biquad$27audio, body$27dom, body_of$27dom, browser_id$27socket, by_id$27dom, cancel_timer$21$27page, capture_pointer$21$27dom, change$27dom, checked$3f$27dom, children_of$27dom, chime_notes$27intro, chimes$27intro, choices$27playlist, choose$27ui, chosen_files$27fetch, clear$21$27dom, clear_source$21$27media, click$27dom, clock$27clock, close$27dom, close_dialog$21$27dom, closest_of$27dom, confirmed$3f$27page, connect$21$27audio, connect$27socket, controls$27remote, converting_refreshes$27search, cookie_get$27page, cookie_set$21$27page, copy_content$21$27dom, data_of$27dom, default_prevented$3f$27dom, delay_node$27audio, destination$27audio, dialogs$3f$27dom, digits$3f$27bar, each_in$27picker, each_of$27intro, each_of$27photos, encode_component$27page, ended$27media, envelope$27intro, every$27page, fetch_text$27fetch, file_input_again$21$27fetch, file_name$27fetch, file_size$27fetch, film_back$27back, film_page$3f$27back, film_plays$27film, filters_apply$27search, first_element_of$27dom, focus$21$27dom, focus_window$21$27page, frame_step$27picker, full$3f$27keypad, fullscreen$21$27page, gain_node$27audio, go$21$27page, go$27bar, handlers$27socket, head_style$27page, heard$27socket, hidden$3f$27dom, hide$21$27remote, history_length$27page, id_of$27dom, import$21$27dom, input$27dom, insert_before$21$27dom, intro_plays$27intro, intro_shows$27intro, join_names$27player, kept$3f$27bar, key_of$27dom, keydown$27dom, keypads_work$27keypad, link_address$27page, load$27dom, loadedmetadata$27media, make_element$27dom, make_player$27player, make_player_options$27player, media_by_id$27media, media_duration$27media, media_in$27media, media_paused$3f$27media, media_ready$3f$27media, media_session$21$27media, media_time$27media, mousemove$27dom, music_buttons$27music, muted$3f$27media, new_playlist$27playlist, noise_source$27audio, note$27ui, nothing$27bar, now_ms$27page, nth$27saver, number_of$27film, number_of$27picker, number_of_field$27film, on$27dom, on_document$27dom, on_media_key$27media, on_once$27dom, on_window$27page, only_able$27where, open_socket$27socket, open_window$27page, opener_session_get$27page, origin$27page, oscillator$27audio, other_screens$27where, page_title$27page, pagehide$27page, pages_swap$27bar, panner$27audio, param$27audio, part_in$27dom, partials$27intro, path$27page, pause$21$27media, pause$27media, pending$27playlist, photo_dialog$27photos, photos_page$27photos, picker_runs$27picker, picker_work$27picker, pickers_work$27picker, piece$27photos, place_pin$27photos, plain_click$3f$27dom, play$21$27media, play$27media, play_then$21$27media, play_where$27where, player$3f$27player, player_current$27player, player_link$3f$27where, player_media$27player, player_options$3f$27player, player_options_asleep$27player, player_options_bar$27player, player_options_film$27player, player_options_on_load$27player, player_options_on_sleep$27player, player_options_on_wake$27player, player_playing$3f$27player, player_position$27player, player_queue$27player, player_reload$27player, player_send$27player, player_sleep$27player, player_state$27player, player_wake$27player, players_start$27bar, playlists_add$27playlist, plays$27film, pointer_x$27dom, pointer_y$27dom, pointerdown$27dom, pointermove$27dom, pointerup$27dom, pop_out$27playlist, popstate$27page, post_form$21$27fetch, post_piece_watched$21$27fetch, prevent_default$21$27dom, previous_of$27dom, push_address$21$27page, query$27dom, query_all$27dom, query_all_in$27dom, query_has$3f$27page, query_in$27dom, query_with$27page, queue_now$27player, quiet_ms$27photos, ramp_to$21$27audio, random$27page, read_page$27page, ready_to_play$27ready, real_of$27said, rect_of$27dom, referrer$27page, reload$21$27page, remote_controls$27remote, remove$21$27dom, remove_class$21$27dom, replace_address$21$27page, resize$27page, saver_runs$27saver, saver_shows$27saver, screen_of$27where, screen_plays$27ready, scroll_to_top$21$27page, search_as_typed$27search, search_now$27search, seek$21$27media, seeked$27media, self$27socket, send$27music, send_to$27where, sent$27where, series_views$27series, session_get$27page, session_remove$21$27page, session_set$21$27page, set_at$21$27audio, set_attribute$21$27dom, set_class$21$27dom, set_field$21$27dom, set_hidden$21$27dom, set_muted$21$27media, set_page_style$21$27dom, set_page_title$21$27page, set_poster$21$27media, set_source$21$27media, set_style$21$27dom, set_text$21$27dom, set_title$21$27dom, set_value$21$27audio, set_volume$21$27media, show_modal$21$27dom, show_subtitles$21$27media, shown_ms$27saver, site_path$27bar, socket_address$27browser$2fsocket, socket_open$27browser$2fsocket, socket_send$21$27browser$2fsocket, sound$27intro, start$21$27audio, start_player$27player, stop$21$27audio, submit$27dom, submit_form$21$27dom, subtitles_showing$3f$27media, swappable$3f$27bar, tab$27socket, tab_id$27socket, tag_of$27dom, targets$27where, text$21$27ready, text$21$27remote, text_of$27dom, this_page$27dom, time_text$27picker, timeupdate$27media, toggle_class$21$27dom, touchstart$27dom, tries$27photos, user_agent$27page, value_of$27dom, volume$27media, volumechange$27media, wait$27socket, waiting$27where, with_pairs$27player, without$27saver;
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
      ($B["equal?"]($B["map-ref"](msg$275, "type", ""), "you") ? (set_page_style$21$27dom("--safe-w", $B["string-append"]($B["number->string"]($B["map-ref"](msg$275, "safe_w", 80)), "vw")), set_page_style$21$27dom("--safe-h", $B["string-append"]($B["number->string"]($B["map-ref"](msg$275, "safe_h", 90)), "vh")), (self$27socket = $theMap(msg$275))) : false);
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
      let main$2712, page$2711, sheet$2716, style$2714, their_sheet$2717, their_style$2715, theirs$2713;
      (page$2711 = read_page$27page(html));
      (main$2712 = query$27dom("main"));
      (theirs$2713 = query_in$27dom(page$2711, "main"));
      (style$2714 = query$27dom("style"));
      (their_style$2715 = query_in$27dom(page$2711, "style"));
      (sheet$2716 = query$27dom("link[data-sheet]"));
      (their_sheet$2717 = query_in$27dom(page$2711, "link[data-sheet]"));
      if ((((main$2712) !== false ? ((theirs$2713) !== false ? (status === 200) : false) : false)) !== false) {
        ((((style$2714) !== false ? their_style$2715 : false)) !== false ? copy_content$21$27dom(style$2714, their_style$2715) : false);
        (((sheet$2716) !== false ? ((their_sheet$2717) !== false ? ($B["equal?"](attribute_of$27dom(sheet$2716, "href"), attribute_of$27dom(their_sheet$2717, "href")) === false) : false) : false) ? set_attribute$21$27dom(sheet$2716, "href", attribute_of$27dom(their_sheet$2717, "href")) : false);
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
    let box$2718, typing$2719;
    (box$2718 = query$27dom("input[data-search]"));
    (typing$2719 = 0);
    if ((box$2718) !== false) {
      return on$27dom(box$2718, input$27dom, function (e) {
        cancel_timer$21$27page(typing$2719);
        return (typing$2719 = after$27page(250, function () {
          return search_now$27search(box$2718);
        }));
      });
    } else {
      return false;
    }
  });
  (filters_apply$27search = function () {
    let each$2721, filters$2720;
    (filters$2720 = query_all$27dom("[data-filter]"));
    (each$2721 = function (i) {
      let f$2722;
      if ((i < $B["vector-length"](filters$2720))) {
        (f$2722 = $B["vector-ref"](filters$2720, i));
        on$27dom(f$2722, change$27dom, function (e) {
          return submit_form$21$27dom(f$2722);
        });
        return each$2721((i + 1));
      } else {
        return false;
      }
    });
    return each$2721(0);
  });
  (converting_refreshes$27search = function () {
    let n$2724, refresh$2723;
    (refresh$2723 = query$27dom("[data-refresh]"));
    if ((refresh$2723) !== false) {
      return after$27page((1000 * ((n$2724 = $B["string->number"](data_of$27dom(refresh$2723, "refresh"))), ((n$2724) !== false ? $B["exact"](n$2724) : 30))), function () {
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
    let intro$2725;
    (intro$2725 = by_id$27dom("intro"));
    if ((intro$2725) !== false) {
      return intro_shows$27intro(intro$2725);
    } else {
      return false;
    }
  });
  (intro_shows$27intro = function (intro) {
    let audio$2726, begin_playing$2731, gone$2728, leave$2729, or$27value$2736, or$27value$2737, or$27value$2738, show$2732, start$2730, started$2727;
    (audio$2726 = false);
    (started$2727 = false);
    (gone$2728 = false);
    (leave$2729 = function () {
      let done$2733;
      if (gone$2728) {
        return false;
      } else {
        (gone$2728 = true);
        add_class$21$27dom(intro, "leaving");
        after$27page(600, function () {
          return set_hidden$21$27dom(intro, true);
        });
        (done$2733 = audio$2726);
        if ((done$2733) !== false) {
          return after$27page(4000, function () {
            return audio_close$21$27audio(done$2733);
          });
        } else {
          return false;
        }
      }
    });
    (start$2730 = function () {
      if (started$2727) {
        return false;
      } else {
        (started$2727 = true);
        add_class$21$27dom(intro, "playing");
        (((audio$2726) !== false ? audio_running$3f$27audio(audio$2726) : false) ? sound$27intro(audio$2726) : false);
        return after$27page(3700, leave$2729);
      }
    });
    (begin_playing$2731 = function () {
      if (((audio$2726) !== false ? (audio_running$3f$27audio(audio$2726) === false) : false)) {
        return audio_resume$21$27audio(audio$2726, start$2730);
      } else {
        return start$2730();
      }
    });
    (show$2732 = function (asked) {
      let or$27value$2734, or$27value$2735;
      (audio$2726 = audio_context$27audio());
      (started$2727 = false);
      (gone$2728 = false);
      remove_class$21$27dom(intro, "leaving");
      remove_class$21$27dom(intro, "playing");
      set_hidden$21$27dom(intro, false);
      if ((((or$27value$2734 = asked), (or$27value$2734 ? or$27value$2734 : ((or$27value$2735 = (audio$2726 === false)), (or$27value$2735 ? or$27value$2735 : ((audio$2726) !== false ? audio_running$3f$27audio(audio$2726) : false)))))) !== false) {
        return begin_playing$2731();
      } else {
        return false;
      }
    });
    on$27dom(intro, click$27dom, function (e) {
      if (started$2727) {
        return leave$2729();
      } else {
        return begin_playing$2731();
      }
    });
    on_document$27dom(keydown$27dom, function (e) {
      if (gone$2728) {
        return false;
      } else {
        if ($B["equal?"](key_of$27dom(e), "Escape")) {
          return leave$2729();
        } else {
          if ((started$2727 === false)) {
            return begin_playing$2731();
          } else {
            return false;
          }
        }
      }
    });
    (again$27intro = function () {
      return show$2732(true);
    });
    if ((((or$27value$2736 = by_id$27dom("player")), ((or$27value$2736) !== false ? or$27value$2736 : ((or$27value$2737 = by_id$27dom("ready")), ((or$27value$2737) !== false ? or$27value$2737 : ((or$27value$2738 = query$27dom("[data-profiles]")), ((or$27value$2738) !== false ? or$27value$2738 : query$27dom("[data-help]")))))))) !== false) {
      return false;
    } else {
      if ((($B["equal?"](session_get$27page("hazelflix-intro"), "") === false) ? (query_has$3f$27page("intro") === false) : false)) {
        return false;
      } else {
        if ((session_set$21$27page("hazelflix-intro", "1") === false)) {
          return false;
        } else {
          return show$2732(false);
        }
      }
    }
  });
  (envelope$27intro = function (g, at, attack, peak, hold, release) {
    let p$2739;
    (p$2739 = param$27audio(g, "gain"));
    set_at$21$27audio(p$2739, 0.0001, 0.0);
    set_at$21$27audio(p$2739, 0.0001, at);
    ramp_to$21$27audio(p$2739, peak, (at + attack));
    set_at$21$27audio(p$2739, peak, (at + (attack + hold)));
    return ramp_to$21$27audio(p$2739, 0.0001, (at + (attack + (hold + release))));
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
    let at$2750, band$2748, echo$2742, feedback$2743, hg$2749, hiss$2747, note$2752, notes$2753, open$2751, out$2741, t0$2740, wet$2744;
    (t0$2740 = (audio_now$27audio(c) + 0.050000000000000003));
    (out$2741 = gain_node$27audio(c));
    (echo$2742 = delay_node$27audio(c, 1.0));
    (feedback$2743 = gain_node$27audio(c));
    (wet$2744 = gain_node$27audio(c));
    set_value$21$27audio(param$27audio(out$2741, "gain"), 0.69999999999999996);
    connect$21$27audio(out$2741, destination$27audio(c));
    set_value$21$27audio(param$27audio(echo$2742, "delayTime"), 0.27000000000000002);
    set_value$21$27audio(param$27audio(feedback$2743, "gain"), 0.32000000000000001);
    set_value$21$27audio(param$27audio(wet$2744, "gain"), 0.28000000000000003);
    connect$21$27audio(echo$2742, feedback$2743);
    connect$21$27audio(feedback$2743, echo$2742);
    connect$21$27audio(echo$2742, wet$2744);
    connect$21$27audio(wet$2744, destination$27audio(c));
    connect$21$27audio(out$2741, echo$2742);
    each_of$27intro(new Pair(49.0, new Pair(49.600000000000001, null)), function (f) {
      let g$2746, o$2745;
      (o$2745 = oscillator$27audio(c, "sine"));
      (g$2746 = gain_node$27audio(c));
      set_at$21$27audio(param$27audio(o$2745, "frequency"), f, t0$2740);
      ramp_to$21$27audio(param$27audio(o$2745, "frequency"), (f * 1.1200000000000001), (t0$2740 + 2.2999999999999998));
      envelope$27intro(g$2746, t0$2740, 1.6000000000000001, 0.32000000000000001, 0.59999999999999998, 1.6000000000000001);
      connect$21$27audio(o$2745, g$2746);
      connect$21$27audio(g$2746, out$2741);
      start$21$27audio(o$2745, t0$2740);
      return stop$21$27audio(o$2745, (t0$2740 + 4.2000000000000002));
    });
    ((hiss$2747 = noise_source$27audio(c, 2.0)), (band$2748 = biquad$27audio(c, "bandpass")), (hg$2749 = gain_node$27audio(c)), set_value$21$27audio(param$27audio(band$2748, "Q"), 6.0), set_at$21$27audio(param$27audio(band$2748, "frequency"), 700.0, (t0$2740 + 1.1000000000000001)), ramp_to$21$27audio(param$27audio(band$2748, "frequency"), 7000.0, (t0$2740 + 2.2999999999999998)), envelope$27intro(hg$2749, (t0$2740 + 1.1000000000000001), 0.69999999999999996, 0.089999999999999997, 0.29999999999999999, 0.5), connect$21$27audio(hiss$2747, band$2748), connect$21$27audio(band$2748, hg$2749), connect$21$27audio(hg$2749, out$2741), start$21$27audio(hiss$2747, (t0$2740 + 1.1000000000000001)), stop$21$27audio(hiss$2747, (t0$2740 + 3.1000000000000001)));
    (at$2750 = (t0$2740 + 2.2999999999999998));
    (open$2751 = biquad$27audio(c, "lowpass"));
    set_at$21$27audio(param$27audio(open$2751, "frequency"), 500.0, at$2750);
    ramp_to$21$27audio(param$27audio(open$2751, "frequency"), 3000.0, (at$2750 + 1.2));
    connect$21$27audio(open$2751, out$2741);
    (note$2752 = function (f, i) {
      return each_of$27intro(new Pair(-6.0, new Pair(6.0, null)), function (cents) {
        let g$2755, o$2754;
        (o$2754 = oscillator$27audio(c, "triangle"));
        (g$2755 = gain_node$27audio(c));
        set_value$21$27audio(param$27audio(o$2754, "frequency"), f);
        set_value$21$27audio(param$27audio(o$2754, "detune"), cents);
        envelope$27intro(g$2755, (at$2750 + (i * 0.02)), 0.40000000000000002, 0.040000000000000001, 0.59999999999999998, 2.3999999999999999);
        connect$21$27audio(o$2754, g$2755);
        connect$21$27audio(g$2755, open$2751);
        start$21$27audio(o$2754, at$2750);
        return stop$21$27audio(o$2754, (at$2750 + 3.6000000000000001));
      });
    });
    (notes$2753 = function (l, i) {
      for (;;) {
        if ($B["null?"](l)) {
          return true;
        } else {
          note$2752($B["car"](l), i);
          const $t0 = $B["cdr"](l);
          const $t1 = (i + 1.0);
          l = $t0;
          i = $t1;
          continue;
        }
      }
    });
    notes$2753(new Pair(110.0, new Pair(164.81, new Pair(220.0, new Pair(277.18000000000001, new Pair(329.63, null))))), 0.0);
    return chimes$27intro(c, out$2741, at$2750);
  });
  (chime_notes$27intro = $B["vector"](880.0, 987.76999999999998, 1108.73, 1318.51, 1479.98, 1760.0, 1975.53, 2217.46));
  (partials$27intro = new Pair(new Pair(1.0, new Pair(1.0, new Pair(3.2000000000000002, null))), new Pair(new Pair(2.7599999999999998, new Pair(0.41999999999999998, new Pair(1.8999999999999999, null))), new Pair(new Pair(5.4000000000000004, new Pair(0.20000000000000001, new Pair(1.1000000000000001, null))), new Pair(new Pair(8.9299999999999997, new Pair(0.089999999999999997, new Pair(0.59999999999999998, null))), null)))));
  (chimes$27intro = function (c, out, at) {
    let strike;
    (strike = function (i, when, gap, last) {
      let first$2756, n$2757, place$2759, strength$2758;
      if ((i < 11)) {
        (first$2756 = $B["exact"]($B["floor"]((random$27page() * 8))));
        (n$2757 = ((first$2756 === last) ? $B["modulo"]((first$2756 + (1 + $B["exact"]($B["floor"]((random$27page() * 3))))), 8) : first$2756));
        (strength$2758 = (0.074999999999999997 * ((1.0 - ($B["inexact"](i) / 14.0)) * (0.69999999999999996 + (random$27page() * 0.5)))));
        (place$2759 = panner$27audio(c));
        ((place$2759) !== false ? (set_value$21$27audio(param$27audio(place$2759, "pan"), ((random$27page() * 1.3999999999999999) - 0.69999999999999996)), connect$21$27audio(place$2759, out)) : false);
        each_of$27intro(partials$27intro, function (p) {
          return each_of$27intro(new Pair(-4.0, new Pair(4.0, null)), function (cents) {
            let g$2761, o$2760, ring$2762;
            (o$2760 = oscillator$27audio(c, "sine"));
            (g$2761 = gain_node$27audio(c));
            (ring$2762 = $B["car"]($B["cdr"]($B["cdr"](p))));
            set_value$21$27audio(param$27audio(o$2760, "frequency"), ($B["vector-ref"](chime_notes$27intro, n$2757) * $B["car"](p)));
            set_value$21$27audio(param$27audio(o$2760, "detune"), (cents + ((random$27page() * 4.0) - 2.0)));
            set_at$21$27audio(param$27audio(g$2761, "gain"), 0.0001, when);
            ramp_to$21$27audio(param$27audio(g$2761, "gain"), (strength$2758 * $B["car"]($B["cdr"](p))), (when + 0.0040000000000000001));
            ramp_to$21$27audio(param$27audio(g$2761, "gain"), 0.0001, (when + ring$2762));
            connect$21$27audio(o$2760, g$2761);
            connect$21$27audio(g$2761, ((place$2759) !== false ? place$2759 : out));
            start$21$27audio(o$2760, when);
            return stop$21$27audio(o$2760, (when + (ring$2762 + 0.050000000000000003)));
          });
        });
        return strike((i + 1), (when + (gap + (random$27page() * gap))), (gap * 1.22), n$2757);
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
    let h$2764, m$2765, n$27i2, n$27i3, t$2763;
    (t$2763 = ((s > 0.0) ? $B["exact"]($B["floor"](s)) : 0));
    (h$2764 = $B["quotient"](t$2763, 3600));
    (m$2765 = $B["quotient"]($B["remainder"](t$2763, 3600), 60));
    return $B["string-append"](((h$2764 > 0) ? $B["string-append"]($B["number->string"](h$2764), ":", ((n$27i2 = m$2765), ((n$27i2 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i2)) : $B["number->string"](n$27i2)))) : $B["number->string"](m$2765)), ":", ((n$27i3 = $B["remainder"](t$2763, 60)), ((n$27i3 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i3)) : $B["number->string"](n$27i3))));
  });
  (real_of$27said = function (x) {
    if ($B["number?"](x)) {
      return $theReal((x + 0.0));
    } else {
      return 0.0;
    }
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
    let art$2769, asleep$2781, bar$2782, current$2787, current$27i80, dragging$2778, expected$2788, film_of$2783, handler$27i62, handler$27i63, handler$27i65, handler$27i68, heard$2777, items$2785, labels$21$2790, list_items$2795, listed$2779, live$2780, load$27dom$2791, loaded$2775, media$2768, media$27i85, number_in$2799, offset$2776, play_or_not$2792, playing$3f$27i81, position$2789, position$27i79, queue$27i82, queues$21$2796, received$2774, reload$27i84, render$2793, row$21$2794, seek$2770, select$27146, send$2786, send$27i78, sleep$2798, sleep$27i77, start$2771, state$2773, state$27i83, told$2784, volume$27media$27162, wake$2797, wake$27i76, wanted$2772, x$27i4;
    (media$2768 = media_in$27media(root, "[data-p=media]"));
    (art$2769 = part_in$27dom(root, $B["string-append"]("[data-p=", "art", "]"), "img"));
    (seek$2770 = part_in$27dom(root, $B["string-append"]("[data-p=", "seek", "]"), "input"));
    (start$2771 = part_in$27dom(root, $B["string-append"]("[data-p=", "start", "]"), "button"));
    (wanted$2772 = ((x$27i4 = $B["string->number"](data_of$27dom(root, "queue"))), $B["exact"]($B["floor"](real_of$27said(x$27i4)))));
    (state$2773 = false);
    (received$2774 = 0.0);
    (loaded$2775 = 0);
    (offset$2776 = 0.0);
    (heard$2777 = false);
    (dragging$2778 = false);
    (listed$2779 = "");
    (live$2780 = false);
    (asleep$2781 = $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 0, options));
    (bar$2782 = $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 1, options));
    (asleep$2781 ? false : (queue_now$27player = wanted$2772));
    (film_of$2783 = function (item) {
      let kind$2766$27i5, or$27value$2767$27i6;
      if (((kind$2766$27i5 = $B["map-ref"](item, "kind", "")), ((or$27value$2767$27i6 = $B["equal?"](kind$2766$27i5, "film")), (or$27value$2767$27i6 ? or$27value$2767$27i6 : $B["equal?"](kind$2766$27i5, "episode"))))) {
        return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 2, options)(item);
      } else {
        return false;
      }
    });
    (told$2784 = function () {
      if ((state$2773) !== false) {
        return state$2773;
      } else {
        return $B["map-of"]();
      }
    });
    (items$2785 = function () {
      return $B["map-ref"](told$2784(), "items", $B["vector"]());
    });
    (send$2786 = function (op, extra) {
      let msg$27i7;
      (msg$27i7 = with_pairs$27player($B["map-of"]("type", "queue", "op", op, "queue", ((state$2773) !== false ? $B["map-ref"](told$2784(), "id", 0) : wanted$2772)), extra));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i7));
      } else {
        return false;
      }
    });
    (current$2787 = function () {
      if (($B["vector-length"](items$2785()) > 0)) {
        return $B["vector-ref"](items$2785(), $B["map-ref"](told$2784(), "at", 0));
      } else {
        return false;
      }
    });
    (expected$2788 = function () {
      let x$27i8;
      return (real_of$27said($B["map-ref"](told$2784(), "position", 0)) + (((x$27i8 = $B["map-ref"](told$2784(), "paused", false)), ((x$27i8) !== false ? (((x$27i8 === $sym("null")) === false) ? (($B["equal?"](x$27i8, 0) === false) ? ($B["equal?"](x$27i8, "") === false) : false) : false) : false)) ? 0.0 : ((now_ms$27page() - received$2774) / 1000.0)));
    });
    (position$2789 = function () {
      return (offset$2776 + media_time$27media(media$2768));
    });
    (labels$21$2790 = function (item, artist_text, artist_href, album_text, album_href) {
      let album$27101, artist$27100, before$27102, x$27i9;
      set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "title", "]"), "span"), ((x$27i9 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i9) ? x$27i9 : ($B["number?"](x$27i9) ? $B["number->string"](x$27i9) : ""))));
      (artist$27100 = part_in$27dom(root, $B["string-append"]("[data-p=", "artist", "]"), "a"));
      (album$27101 = part_in$27dom(root, $B["string-append"]("[data-p=", "album", "]"), "a"));
      set_text$21$27dom(artist$27100, artist_text);
      set_attribute$21$27dom(artist$27100, "href", artist_href);
      set_text$21$27dom(album$27101, album_text);
      set_attribute$21$27dom(album$27101, "href", album_href);
      (before$27102 = previous_of$27dom(album$27101));
      if ((before$27102) !== false) {
        return set_hidden$21$27dom(before$27102, $B["equal?"](album_text, ""));
      } else {
        return false;
      }
    });
    (load$27dom$2791 = function (item) {
      let at$27104, e$27105, or$27value$27108, or$27value$27109, p$27103, pictured$27107, src$27106, x$27i10, x$27i11, x$27i12, x$27i13, x$27i14, x$27i15, x$27i16, x$27i17, x$27i18, x$27i19, x$27i20, x$27i21, x$27i22, x$27i23, x$27i24, x$27i25, x$27i26, x$27i27, x$27i28;
      (p$27103 = film_of$2783(item));
      (at$27104 = ((e$27105 = ((x$27i10 = expected$2788()), $B["exact"]($B["floor"](real_of$27said(x$27i10))))), ((e$27105 > 0) ? e$27105 : 0)));
      (loaded$2775 = ((x$27i11 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i11)))));
      (heard$2777 = false);
      ((p$27103) !== false ? ((live$2780 = (((x$27i12 = $B["map-ref"](p$27103, "ready", false)), ((x$27i12) !== false ? (((x$27i12 === $sym("null")) === false) ? (($B["equal?"](x$27i12, 0) === false) ? ($B["equal?"](x$27i12, "") === false) : false) : false) : false)) === false)), (offset$2776 = (live$2780 ? real_of$27said(at$27104) : 0.0)), set_source$21$27media(media$2768, (live$2780 ? $B["string-append"]("/live/", ((x$27i13 = $B["map-ref"](p$27103, "file", 0)), ($B["string?"](x$27i13) ? x$27i13 : ($B["number?"](x$27i13) ? $B["number->string"](x$27i13) : ""))), "?t=", $B["number->string"](at$27104), (((x$27i14 = $B["map-ref"](p$27103, "format", 0)), ((x$27i14) !== false ? (((x$27i14 === $sym("null")) === false) ? (($B["equal?"](x$27i14, 0) === false) ? ($B["equal?"](x$27i14, "") === false) : false) : false) : false)) ? $B["string-append"]("&format=", ((x$27i15 = $B["map-ref"](p$27103, "format", 0)), ($B["string?"](x$27i15) ? x$27i15 : ($B["number?"](x$27i15) ? $B["number->string"](x$27i15) : "")))) : "")) : ((x$27i16 = $B["map-ref"](p$27103, "source", "")), ($B["string?"](x$27i16) ? x$27i16 : ($B["number?"](x$27i16) ? $B["number->string"](x$27i16) : "")))))) : ((src$27106 = ((x$27i17 = $B["map-ref"](item, "src", "")), ($B["string?"](x$27i17) ? x$27i17 : ($B["number?"](x$27i17) ? $B["number->string"](x$27i17) : "")))), (live$2780 = ((x$27i18 = $B["map-ref"](item, "live", false)), ((x$27i18) !== false ? (((x$27i18 === $sym("null")) === false) ? (($B["equal?"](x$27i18, 0) === false) ? ($B["equal?"](x$27i18, "") === false) : false) : false) : false))), (offset$2776 = (live$2780 ? real_of$27said(at$27104) : 0.0)), set_source$21$27media(media$2768, (live$2780 ? $B["string-append"](src$27106, "?t=", $B["number->string"](at$27104)) : src$27106))));
      (((live$2780 === false) ? (at$27104 > 0) : false) ? on_once$27dom(media$2768, loadedmetadata$27media, function (e) {
        return seek$21$27media(media$2768, expected$2788());
      }) : false);
      ((pictured$27107 = ((or$27value$27108 = ((p$27103) !== false ? true : false)), (or$27value$27108 ? or$27value$27108 : $B["equal?"]($B["map-ref"](item, "kind", ""), "video")))), set_hidden$21$27dom(media$2768, ((or$27value$27109 = (pictured$27107 === false)), (or$27value$27109 ? or$27value$27109 : bar$2782))), set_hidden$21$27dom(art$2769, (pictured$27107 ? (bar$2782 === false) : false)));
      set_attribute$21$27dom(art$2769, "src", ((x$27i19 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i19) ? x$27i19 : ($B["number?"](x$27i19) ? $B["number->string"](x$27i19) : ""))));
      labels$21$2790(item, ((x$27i20 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i20) ? x$27i20 : ($B["number?"](x$27i20) ? $B["number->string"](x$27i20) : ""))), $B["string-append"]("/artist/", ((x$27i21 = $B["map-ref"](item, "artist_id", "")), ($B["string?"](x$27i21) ? x$27i21 : ($B["number?"](x$27i21) ? $B["number->string"](x$27i21) : "")))), ((x$27i22 = $B["map-ref"](item, "album", "")), ($B["string?"](x$27i22) ? x$27i22 : ($B["number?"](x$27i22) ? $B["number->string"](x$27i22) : ""))), (((x$27i23 = $B["map-ref"](item, "album_id", 0)), ((x$27i23) !== false ? (((x$27i23 === $sym("null")) === false) ? (($B["equal?"](x$27i23, 0) === false) ? ($B["equal?"](x$27i23, "") === false) : false) : false) : false)) ? $B["string-append"]("/album/", ((x$27i24 = $B["map-ref"](item, "album_id", 0)), ($B["string?"](x$27i24) ? x$27i24 : ($B["number?"](x$27i24) ? $B["number->string"](x$27i24) : "")))) : "#"));
      media_session$21$27media(((x$27i25 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i25) ? x$27i25 : ($B["number?"](x$27i25) ? $B["number->string"](x$27i25) : ""))), ((x$27i26 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i26) ? x$27i26 : ($B["number?"](x$27i26) ? $B["number->string"](x$27i26) : ""))), ((x$27i27 = $B["map-ref"](item, "album", "")), ($B["string?"](x$27i27) ? x$27i27 : ($B["number?"](x$27i27) ? $B["number->string"](x$27i27) : ""))), ((x$27i28 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i28) ? x$27i28 : ($B["number?"](x$27i28) ? $B["number->string"](x$27i28) : ""))));
      return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 3, options)(item, p$27103);
    });
    (play_or_not$2792 = function () {
      let x$27i29;
      if (((x$27i29 = $B["map-ref"](told$2784(), "paused", false)), ((x$27i29) !== false ? (((x$27i29 === $sym("null")) === false) ? (($B["equal?"](x$27i29, 0) === false) ? ($B["equal?"](x$27i29, "") === false) : false) : false) : false))) {
        return pause$21$27media(media$2768);
      } else {
        return play_then$21$27media(media$2768, function () {
          return set_hidden$21$27dom(start$2771, true);
        }, function () {
          return set_hidden$21$27dom(start$2771, false);
        });
      }
    });
    (render$2793 = function () {
      let how$27119, item$27110, item$27i30, kind$2766$27i31, me$27114, n$27111, names$27115, off$27112, or$27value$2767$27i32, others$27116, players$27113, repeat$27118, shuffle$27117, title$27120, x$27i33, x$27i34, x$27i35, x$27i36, x$27i37, x$27i38, x$27i39, x$27i41, x$27i42, x$27i43, x$27i44;
      (item$27110 = current$2787());
      (n$27111 = $B["vector-length"](items$2785()));
      set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "count", "]"), "span"), ((n$27111 === 0) ? "" : ((n$27111 === 1) ? "1 item" : $B["string-append"]($B["number->string"](n$27111), " items"))));
      ((item$27110 === false) ? ((loaded$2775 = 0), pause$21$27media(media$2768), clear_source$21$27media(media$2768), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "title", "]"), "span"), "Nothing playing")) : ((((item$27i30 = item$27110), ((kind$2766$27i31 = $B["map-ref"](item$27i30, "kind", "")), ((or$27value$2767$27i32 = $B["equal?"](kind$2766$27i31, "film")), (or$27value$2767$27i32 ? or$27value$2767$27i32 : $B["equal?"](kind$2766$27i31, "episode"))))) ? (film_of$2783(item$27110) === false) : false) ? (($B["equal?"]($B["map-ref"](item$27110, "id", 0), loaded$2775) ? false : ((loaded$2775 = ((x$27i33 = $B["map-ref"](item$27110, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i33))))), pause$21$27media(media$2768), clear_source$21$27media(media$2768), set_hidden$21$27dom(media$2768, true), set_hidden$21$27dom(art$2769, false), set_attribute$21$27dom(art$2769, "src", ((x$27i34 = $B["map-ref"](item$27110, "art", "")), ($B["string?"](x$27i34) ? x$27i34 : ($B["number?"](x$27i34) ? $B["number->string"](x$27i34) : "")))), labels$21$2790(item$27110, ((x$27i35 = $B["map-ref"](item$27110, "label", "")), ($B["string?"](x$27i35) ? x$27i35 : ($B["number?"](x$27i35) ? $B["number->string"](x$27i35) : ""))), ((x$27i36 = $B["map-ref"](item$27110, "src", "")), ($B["string?"](x$27i36) ? x$27i36 : ($B["number?"](x$27i36) ? $B["number->string"](x$27i36) : ""))), "", "#"))), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(expected$2788())), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "length", "]"), "span"), clock$27clock(real_of$27said($B["map-ref"](item$27110, "duration", 0)))), (dragging$2778 ? false : (set_attribute$21$27dom(seek$2770, "max", $B["number->string"](((x$27i37 = $B["map-ref"](item$27110, "duration", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i37)))))), set_field$21$27dom(seek$2770, $B["number->string"](((x$27i38 = expected$2788()), $B["exact"]($B["floor"](real_of$27said(x$27i38))))))))) : (($B["equal?"]($B["map-ref"](item$27110, "id", 0), loaded$2775) === false) ? (load$27dom$2791(item$27110), play_or_not$2792()) : (play_or_not$2792(), ((off$27112 = (position$2789() - expected$2788())), (((((x$27i39 = $B["map-ref"](told$2784(), "paused", false)), ((x$27i39) !== false ? (((x$27i39 === $sym("null")) === false) ? (($B["equal?"](x$27i39, 0) === false) ? ($B["equal?"](x$27i39, "") === false) : false) : false) : false)) === false) ? (media_ready$3f$27media(media$2768) ? (((off$27112 < 0.0) ? (0.0 - off$27112) : off$27112) > (live$2780 ? 3.0 : 1.0)) : false) : false) ? (live$2780 ? (load$27dom$2791(item$27110), play_or_not$2792()) : seek$21$27media(media$2768, expected$2788())) : false))))));
      ((players$27113 = $B["map-ref"](told$2784(), "players", $B["vector"]())), (me$27114 = browser_id$27socket()), (names$27115 = function (i) {
        let x$27i40;
        for (;;) {
          if ((i >= $B["vector-length"](players$27113))) {
            return null;
          } else {
            if ($B["equal?"]($B["map-ref"]($B["vector-ref"](players$27113, i), "id", ""), me$27114)) {
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return $B["cons"](((x$27i40 = $B["map-ref"]($B["vector-ref"](players$27113, i), "name", "")), ($B["string?"](x$27i40) ? x$27i40 : ($B["number?"](x$27i40) ? $B["number->string"](x$27i40) : ""))), names$27115((i + 1)));
            }
          }
        }
      }), ((others$27116 = ($B["vector?"](players$27113) ? names$27115(0) : null)), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "note", "]"), "span"), ($B["null?"](others$27116) ? "" : $B["string-append"]("Also playing on: ", join_names$27player(others$27116))))));
      set_hidden$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "play", "]"), "button"), (((x$27i41 = $B["map-ref"](told$2784(), "paused", false)), ((x$27i41) !== false ? (((x$27i41 === $sym("null")) === false) ? (($B["equal?"](x$27i41, 0) === false) ? ($B["equal?"](x$27i41, "") === false) : false) : false) : false)) === false));
      set_hidden$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "pause", "]"), "button"), ((x$27i42 = $B["map-ref"](told$2784(), "paused", false)), ((x$27i42) !== false ? (((x$27i42 === $sym("null")) === false) ? (($B["equal?"](x$27i42, 0) === false) ? ($B["equal?"](x$27i42, "") === false) : false) : false) : false)));
      ((shuffle$27117 = query_in$27dom(root, "[data-player=shuffle]")), (repeat$27118 = query_in$27dom(root, "[data-player=repeat]")), (how$27119 = ((x$27i43 = $B["map-ref"](told$2784(), "repeat", "off")), ($B["string?"](x$27i43) ? x$27i43 : ($B["number?"](x$27i43) ? $B["number->string"](x$27i43) : "")))), ((shuffle$27117) !== false ? toggle_class$21$27dom(shuffle$27117, "on", ((x$27i44 = $B["map-ref"](told$2784(), "shuffle", false)), ((x$27i44) !== false ? (((x$27i44 === $sym("null")) === false) ? (($B["equal?"](x$27i44, 0) === false) ? ($B["equal?"](x$27i44, "") === false) : false) : false) : false))) : false), ((repeat$27118) !== false ? ((title$27120 = $B["string-append"]("Repeat: ", ($B["equal?"](how$27119, "one") ? "this one" : how$27119))), toggle_class$21$27dom(repeat$27118, "on", ($B["equal?"](how$27119, "off") === false)), set_title$21$27dom(repeat$27118, title$27120), set_attribute$21$27dom(repeat$27118, "aria-label", title$27120)) : false));
      return list_items$2795();
    });
    (row$21$2794 = function (box, item, i) {
      let a$27133, act$21$27128, acts$27125, art$27126, kind$27127, n$27131, pic$27132, row$27121, sub$27124, tile$27130, title$27123, words$27122, x$27i45, x$27i46, x$27i47, x$27i48, x$27i49, x$27i50, x$27i51;
      (row$27121 = make_element$27dom("div"));
      (words$27122 = make_element$27dom("div"));
      (title$27123 = make_element$27dom("div"));
      (sub$27124 = make_element$27dom("div"));
      (acts$27125 = make_element$27dom("div"));
      (art$27126 = ((x$27i45 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i45) ? x$27i45 : ($B["number?"](x$27i45) ? $B["number->string"](x$27i45) : ""))));
      (kind$27127 = $B["map-ref"](item, "kind", ""));
      (act$21$27128 = function (name, mark, label) {
        let b$27129;
        (b$27129 = make_element$27dom("button"));
        set_attribute$21$27dom(b$27129, "type", "button");
        set_attribute$21$27dom(b$27129, "data-act", name);
        set_text$21$27dom(b$27129, mark);
        set_title$21$27dom(b$27129, label);
        set_attribute$21$27dom(b$27129, "aria-label", label);
        return append$21$27dom(acts$27125, b$27129);
      });
      set_class$21$27dom(row$27121, ((i === $B["map-ref"](told$2784(), "at", 0)) ? "queue-row now" : "queue-row"));
      set_attribute$21$27dom(row$27121, "data-item", ((x$27i46 = $B["map-ref"](item, "id", 0)), ($B["string?"](x$27i46) ? x$27i46 : ($B["number?"](x$27i46) ? $B["number->string"](x$27i46) : ""))));
      ($B["equal?"](art$27126, "") ? ((tile$27130 = make_element$27dom("div")), (n$27131 = (((x$27i47 = $B["map-ref"](item, "song", 0)), ((x$27i47) !== false ? (((x$27i47 === $sym("null")) === false) ? (($B["equal?"](x$27i47, 0) === false) ? ($B["equal?"](x$27i47, "") === false) : false) : false) : false)) ? ((x$27i48 = $B["map-ref"](item, "song", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i48)))) : ((x$27i49 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i49)))))), set_class$21$27dom(tile$27130, "queue-tile"), set_style$21$27dom(tile$27130, "background", $B["string-append"]("hsl(", $B["number->string"]($B["modulo"]((n$27131 * 47), 360)), ", 38%, 30%)")), append$21$27dom(row$27121, tile$27130)) : ((pic$27132 = make_element$27dom("img")), set_attribute$21$27dom(pic$27132, "src", art$27126), set_attribute$21$27dom(pic$27132, "alt", ""), set_attribute$21$27dom(pic$27132, "loading", "lazy"), append$21$27dom(row$27121, pic$27132)));
      set_style$21$27dom(words$27122, "min-width", "0");
      set_class$21$27dom(title$27123, "queue-title");
      set_text$21$27dom(title$27123, $B["string-append"](((x$27i50 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i50) ? x$27i50 : ($B["number?"](x$27i50) ? $B["number->string"](x$27i50) : ""))), ($B["equal?"](kind$27127, "video") ? "  (video)" : ($B["equal?"](kind$27127, "film") ? "  (film)" : ""))));
      set_class$21$27dom(sub$27124, "queue-sub");
      set_text$21$27dom(sub$27124, $B["string-append"](((a$27133 = ((x$27i51 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i51) ? x$27i51 : ($B["number?"](x$27i51) ? $B["number->string"](x$27i51) : "")))), ($B["equal?"](a$27133, "") ? "" : $B["string-append"](a$27133, " \xc2\xb7 "))), clock$27clock(real_of$27said($B["map-ref"](item, "duration", 0)))));
      append$21$27dom(words$27122, title$27123);
      append$21$27dom(words$27122, sub$27124);
      act$21$27128("up", "\xe2\x96\xb2", "Up");
      act$21$27128("down", "\xe2\x96\xbc", "Down");
      act$21$27128("remove", "\xe2\x9c\x95", "Remove");
      append$21$27dom(row$27121, words$27122);
      append$21$27dom(row$27121, acts$27125);
      return append$21$27dom(box, row$27121);
    });
    (list_items$2795 = function () {
      let all$27135, box$27134, each$27140, ids$27136, key$27137, or$27value$27138, p$27139, x$27i53;
      (box$27134 = query_in$27dom(root, "[data-p=items]"));
      (all$27135 = items$2785());
      (ids$27136 = function (i) {
        let x$27i52;
        if ((i >= $B["vector-length"](all$27135))) {
          return "";
        } else {
          return $B["string-append"](",", ((x$27i52 = $B["map-ref"]($B["vector-ref"](all$27135, i), "id", 0)), ($B["string?"](x$27i52) ? x$27i52 : ($B["number?"](x$27i52) ? $B["number->string"](x$27i52) : ""))), ids$27136((i + 1)));
        }
      });
      (key$27137 = $B["string-append"](((x$27i53 = $B["map-ref"](told$2784(), "at", 0)), ($B["string?"](x$27i53) ? x$27i53 : ($B["number?"](x$27i53) ? $B["number->string"](x$27i53) : ""))), ":", ids$27136(0)));
      if (((or$27value$27138 = (box$27134 === false)), (or$27value$27138 ? or$27value$27138 : $B["equal?"](key$27137, listed$2779)))) {
        return false;
      } else {
        (listed$2779 = key$27137);
        clear$21$27dom(box$27134);
        if (($B["vector-length"](all$27135) === 0)) {
          (p$27139 = make_element$27dom("p"));
          set_style$21$27dom(p$27139, "color", "var(--muted, #888)");
          set_text$21$27dom(p$27139, "Empty. Play an album, an artist or a song from Music, or add one with +.");
          return append$21$27dom(box$27134, p$27139);
        } else {
          (each$27140 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](all$27135))) {
                row$21$2794(box$27134, $B["vector-ref"](all$27135, i), i);
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          });
          return each$27140(0);
        }
      }
    });
    (queues$21$2796 = function (l) {
      let each$27142, select$27141, x$27i57;
      (select$27141 = query_in$27dom(root, "[data-p=queue]"));
      if ((select$27141) !== false) {
        clear$21$27dom(select$27141);
        ((each$27142 = function (i) {
          let o$27144, q$27143, x$27i54, x$27i55, x$27i56;
          for (;;) {
            if ((i < $B["vector-length"](l))) {
              (q$27143 = $B["vector-ref"](l, i));
              (o$27144 = make_element$27dom("option"));
              set_attribute$21$27dom(o$27144, "value", ((x$27i54 = $B["map-ref"](q$27143, "id", 0)), ($B["string?"](x$27i54) ? x$27i54 : ($B["number?"](x$27i54) ? $B["number->string"](x$27i54) : ""))));
              set_text$21$27dom(o$27144, $B["string-append"](((x$27i55 = $B["map-ref"](q$27143, "name", "")), ($B["string?"](x$27i55) ? x$27i55 : ($B["number?"](x$27i55) ? $B["number->string"](x$27i55) : ""))), " (", ((x$27i56 = $B["map-ref"](q$27143, "n", 0)), ($B["string?"](x$27i56) ? x$27i56 : ($B["number?"](x$27i56) ? $B["number->string"](x$27i56) : ""))), ")"));
              append$21$27dom(select$27141, o$27144);
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return false;
            }
          }
        }), each$27142(0));
        if ((state$2773) !== false) {
          return set_field$21$27dom(select$27141, ((x$27i57 = $B["map-ref"](told$2784(), "id", 0)), ($B["string?"](x$27i57) ? x$27i57 : ($B["number?"](x$27i57) ? $B["number->string"](x$27i57) : ""))));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    (wake$2797 = function (queue) {
      let msg$27i58;
      (asleep$2781 = false);
      (wanted$2772 = queue);
      (loaded$2775 = 0);
      (listed$2779 = "");
      $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 4, options)();
      (msg$27i58 = $B["map-of"]("type", "player", "queue", wanted$2772));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i58));
      } else {
        return false;
      }
    });
    (sleep$2798 = function () {
      let msg$27i59;
      (asleep$2781 = true);
      (state$2773 = false);
      (loaded$2775 = 0);
      pause$21$27media(media$2768);
      clear_source$21$27media(media$2768);
      $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 5, options)();
      (msg$27i59 = $B["map-of"]("type", "player", "stop", true));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i59));
      } else {
        return false;
      }
    });
    (number_in$2799 = function (e) {
      let x$27i60;
      (x$27i60 = $B["string->number"](value_of$27dom(e)));
      return $B["exact"]($B["floor"](real_of$27said(x$27i60)));
    });
    ((handler$27i62 = function (text, m) {
      let msg$27i61;
      if (asleep$2781) {
        return false;
      } else {
        (msg$27i61 = $B["map-of"]("type", "player", "queue", wanted$2772));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i61));
        } else {
          return false;
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i62)))));
    ((handler$27i63 = function (text, m) {
      return queues$21$2796($B["map-ref"](m, "queues", $B["vector"]()));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queues", $B["append"]($B["map-ref"](handlers$27socket, "queues", null), $listFromEnd(handler$27i63)))));
    ((handler$27i65 = function (text, m) {
      let or$27value$27145, x$27i64;
      if ((((or$27value$27145 = asleep$2781), (or$27value$27145 ? or$27value$27145 : ((wanted$2772 > 0) ? ($B["equal?"]($B["map-ref"](m, "id", 0), wanted$2772) === false) : false)))) !== false) {
        return false;
      } else {
        (wanted$2772 = ((x$27i64 = $B["map-ref"](m, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i64)))));
        (queue_now$27player = wanted$2772);
        (state$2773 = m);
        (received$2774 = now_ms$27page());
        set_field$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "queue", "]"), "select"), $B["number->string"](wanted$2772));
        ((($B["equal?"](path$27page(), "/music/player") ? (bar$2782 === false) : false)) !== false ? replace_address$21$27page($B["string-append"]("/music/player?", query_with$27page("queue", $B["number->string"](wanted$2772)))) : false);
        return render$2793();
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue", $B["append"]($B["map-ref"](handlers$27socket, "queue", null), $listFromEnd(handler$27i65)))));
    ((handler$27i68 = function (text, m) {
      let msg$27i67, x$27i66;
      if (asleep$2781) {
        return false;
      } else {
        (wanted$2772 = ((x$27i66 = $B["map-ref"](m, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i66)))));
        (msg$27i67 = $B["map-of"]("type", "player", "queue", wanted$2772));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i67));
        } else {
          return false;
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue-made", $B["append"]($B["map-ref"](handlers$27socket, "queue-made", null), $listFromEnd(handler$27i68)))));
    ((select$27146 = part_in$27dom(root, $B["string-append"]("[data-p=", "queue", "]"), "select")), on$27dom(select$27146, change$27dom, function (e) {
      let msg$27i69;
      (wanted$2772 = number_in$2799(select$27146));
      (loaded$2775 = 0);
      (msg$27i69 = $B["map-of"]("type", "player", "queue", wanted$2772));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i69));
      } else {
        return false;
      }
    }));
    on$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "new", "]"), "button"), click$27dom, function (e) {
      let msg$27i70, name$27147;
      (name$27147 = ask$27page("The new queue's name", ""));
      if ((name$27147) !== false) {
        (msg$27i70 = $B["map-of"]("type", "queue", "op", "new", "name", name$27147));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i70));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    on$27dom(root, click$27dom, function (e) {
      let act$27152, all$27153, button$27151, control$27148, find$27155, item$27150, place$27154, row$27149, x$27i71;
      (control$27148 = closest_of$27dom(e, "[data-player]"));
      if ((control$27148) !== false) {
        return send$2786(data_of$27dom(control$27148, "player"), null);
      } else {
        (row$27149 = closest_of$27dom(e, ".queue-row"));
        if ((((row$27149) !== false ? state$2773 : false)) !== false) {
          (item$27150 = ((x$27i71 = $B["string->number"](data_of$27dom(row$27149, "item"))), $B["exact"]($B["floor"](real_of$27said(x$27i71)))));
          (button$27151 = closest_of$27dom(e, "[data-act]"));
          (act$27152 = ((button$27151) !== false ? data_of$27dom(button$27151, "act") : ""));
          (all$27153 = items$2785());
          (place$27154 = ((find$27155 = function (i) {
            for (;;) {
              if ((i >= $B["vector-length"](all$27153))) {
                return -1;
              } else {
                if ($B["equal?"]($B["map-ref"]($B["vector-ref"](all$27153, i), "id", 0), item$27150)) {
                  return i;
                } else {
                  const $t0 = (i + 1);
                  i = $t0;
                  continue;
                }
              }
            }
          }), find$27155(0)));
          if ($B["equal?"](act$27152, "remove")) {
            return send$2786("remove", $listFromEnd($B["cons"]("item", item$27150)));
          } else {
            if (($B["equal?"](act$27152, "up") ? (place$27154 > 0) : false)) {
              return send$2786("move", $listFromEnd($B["cons"]("to", (place$27154 - 1)), $B["cons"]("item", item$27150)));
            } else {
              if (($B["equal?"](act$27152, "down") ? (place$27154 < ($B["vector-length"](all$27153) - 1)) : false)) {
                return send$2786("move", $listFromEnd($B["cons"]("to", (place$27154 + 1)), $B["cons"]("item", item$27150)));
              } else {
                if ($B["equal?"](act$27152, "")) {
                  return send$2786("jump", $listFromEnd($B["cons"]("item", item$27150)));
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
    on$27dom(start$2771, click$27dom, function (e) {
      return play_then$21$27media(media$2768, function () {
        return set_hidden$21$27dom(start$2771, true);
      }, function () {
        return false;
      });
    });
    on$27dom(media$2768, ended$27media, function (e) {
      let item$27156;
      (item$27156 = current$2787());
      if ((((item$27156) !== false ? (asleep$2781 === false) : false)) !== false) {
        return send$2786("ended", $listFromEnd($B["cons"]("item", $B["map-ref"](item$27156, "id", 0))));
      } else {
        return false;
      }
    });
    on$27dom(media$2768, timeupdate$27media, function (e) {
      let at$27158, d$27161, half$27160, item$27157, length$27159, x$27i72, x$27i73, x$27i74;
      (item$27157 = current$2787());
      if ((((item$27157) !== false ? (asleep$2781 === false) : false)) !== false) {
        (at$27158 = position$2789());
        (length$27159 = ((d$27161 = real_of$27said($B["map-ref"](item$27157, "duration", 0))), ((d$27161 > 0.0) ? d$27161 : media_duration$27media(media$2768))));
        (half$27160 = (length$27159 / 2.0));
        (((heard$2777 === false) ? (((x$27i72 = $B["map-ref"](item$27157, "song", 0)), ((x$27i72) !== false ? (((x$27i72 === $sym("null")) === false) ? (($B["equal?"](x$27i72, 0) === false) ? ($B["equal?"](x$27i72, "") === false) : false) : false) : false)) ? (at$27158 > ((half$27160 < 240.0) ? half$27160 : 240.0)) : false) : false) ? ((heard$2777 = true), send$2786("heard", $listFromEnd($B["cons"]("song", $B["map-ref"](item$27157, "song", 0))))) : false);
        (dragging$2778 ? false : (set_attribute$21$27dom(seek$2770, "max", $B["number->string"](((x$27i73 = length$27159), $B["exact"]($B["floor"](real_of$27said(x$27i73)))))), set_field$21$27dom(seek$2770, $B["number->string"](((x$27i74 = at$27158), $B["exact"]($B["floor"](real_of$27said(x$27i74))))))));
        set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock((dragging$2778 ? real_of$27said(number_in$2799(seek$2770)) : at$27158)));
        return set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "length", "]"), "span"), clock$27clock(length$27159));
      } else {
        return false;
      }
    });
    on$27dom(seek$2770, input$27dom, function (e) {
      (dragging$2778 = true);
      return set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(real_of$27said(number_in$2799(seek$2770))));
    });
    on$27dom(seek$2770, change$27dom, function (e) {
      (dragging$2778 = false);
      return send$2786("seek", $listFromEnd($B["cons"]("value", number_in$2799(seek$2770))));
    });
    ((volume$27media$27162 = part_in$27dom(root, $B["string-append"]("[data-p=", "volume", "]"), "input")), on$27dom(volume$27media$27162, input$27dom, function (e) {
      return set_volume$21$27media(media$2768, (real_of$27said(number_in$2799(volume$27media$27162)) / 100.0));
    }));
    on_media_key$27media("play", function () {
      if (asleep$2781) {
        return false;
      } else {
        return send$2786("toggle", null);
      }
    });
    on_media_key$27media("pause", function () {
      if (asleep$2781) {
        return false;
      } else {
        return send$2786("toggle", null);
      }
    });
    on_media_key$27media("nexttrack", function () {
      if (asleep$2781) {
        return false;
      } else {
        return send$2786("next", null);
      }
    });
    on_media_key$27media("previoustrack", function () {
      if (asleep$2781) {
        return false;
      } else {
        return send$2786("prev", null);
      }
    });
    every$27page(2000, function () {
      let x$27i75;
      if ((((asleep$2781 === false) ? ((state$2773) !== false ? ((((x$27i75 = $B["map-ref"](told$2784(), "paused", false)), ((x$27i75) !== false ? (((x$27i75 === $sym("null")) === false) ? (($B["equal?"](x$27i75, 0) === false) ? ($B["equal?"](x$27i75, "") === false) : false) : false) : false)) === false) ? current$2787() : false) : false) : false)) !== false) {
        return render$2793();
      } else {
        return false;
      }
    });
    (wake$27i76 = wake$2797);
    (sleep$27i77 = sleep$2798);
    (send$27i78 = send$2786);
    (position$27i79 = position$2789);
    (current$27i80 = current$2787);
    (playing$3f$27i81 = function () {
      return (asleep$2781 === false);
    });
    (queue$27i82 = function () {
      return wanted$2772;
    });
    (state$27i83 = function () {
      return state$2773;
    });
    (reload$27i84 = function () {
      (loaded$2775 = 0);
      if ((((state$2773) !== false ? (asleep$2781 === false) : false)) !== false) {
        return render$2793();
      } else {
        return false;
      }
    });
    (media$27i85 = media$2768);
    return $B["%record-make"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", wake$27i76, sleep$27i77, send$27i78, position$27i79, current$27i80, playing$3f$27i81, queue$27i82, state$27i83, reload$27i84, media$27i85);
  });
  (note$27ui = function (words) {
    let n$27163;
    (n$27163 = make_element$27dom("div"));
    set_class$21$27dom(n$27163, "music-note");
    set_text$21$27dom(n$27163, words);
    append$21$27dom(body$27dom(), n$27163);
    after$27page(2500, function () {
      return remove$21$27dom(n$27163);
    });
    return false;
  });
  (choose$27ui = function (title, choices) {
    let d$27164, each$27167, heading$27165, option$27166;
    (d$27164 = make_element$27dom("dialog"));
    (heading$27165 = make_element$27dom("h2"));
    set_class$21$27dom(d$27164, "reel-where");
    set_text$21$27dom(heading$27165, title);
    append$21$27dom(d$27164, heading$27165);
    (option$27166 = function (label, act, $class) {
      let b$27168;
      (b$27168 = make_element$27dom("button"));
      set_text$21$27dom(b$27168, label);
      ($B["equal?"]($class, "") ? false : set_class$21$27dom(b$27168, $class));
      on$27dom(b$27168, click$27dom, function (e) {
        close_dialog$21$27dom(d$27164);
        return act();
      });
      return append$21$27dom(d$27164, b$27168);
    });
    (each$27167 = function (l) {
      for (;;) {
        if ($B["null?"](l)) {
          return true;
        } else {
          option$27166($B["car"]($B["car"](l)), $B["cdr"]($B["car"](l)), "");
          const $t0 = $B["cdr"](l);
          l = $t0;
          continue;
        }
      }
    });
    each$27167(choices);
    option$27166("Cancel", function () {
      return false;
    }, "reel-cancel");
    on$27dom(d$27164, close$27dom, function (e) {
      return remove$21$27dom(d$27164);
    });
    append$21$27dom(body$27dom(), d$27164);
    return show_modal$21$27dom(d$27164);
  });
  (pending$27playlist = false);
  (choices$27playlist = function (what, playlists, i, out) {
    let p$27169;
    if ((i < 0)) {
      return out;
    } else {
      (p$27169 = $B["vector-ref"](playlists, i));
      return choices$27playlist(what, playlists, (i - 1), $B["cons"]($B["cons"]($B["string-append"]($B["map-ref"](p$27169, "name"), $B["string-append"](" (", $B["string-append"]($B["number->string"]($B["map-ref"](p$27169, "n", 0)), ")"))), function () {
        let msg$27i86$27i88, playlist$27i87;
        (playlist$27i87 = $B["map-ref"](p$27169, "id"));
        (msg$27i86$27i88 = $B["map-of"]("type", "playlist", "op", "add", "playlist", playlist$27i87, "what", $B["map-ref"](what, "what"), "id", $B["map-ref"](what, "id")));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i86$27i88));
        } else {
          return false;
        }
      }), out));
    }
  });
  (new_playlist$27playlist = function (what) {
    let msg$27i89, name$27170;
    (name$27170 = ask$27page("The new playlist's name", ""));
    if ((name$27170) !== false) {
      (msg$27i89 = $B["map-of"]("type", "playlist", "op", "new", "name", name$27170, "what", $B["map-ref"](what, "what"), "id", $B["map-ref"](what, "id")));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i89));
      } else {
        return false;
      }
    } else {
      return false;
    }
  });
  (playlists_add$27playlist = function () {
    let handler$27i91, handler$27i92, save$27174;
    on_document$27dom(click$27dom, function (e) {
      let b$27171, msg$27i90, n$27172;
      (b$27171 = closest_of$27dom(e, "[data-playlist-add]"));
      if ((b$27171) !== false) {
        prevent_default$21$27dom(e);
        (pending$27playlist = $B["map-of"]("what", data_of$27dom(b$27171, "playlist-add"), "id", ((n$27172 = $B["string->number"](data_of$27dom(b$27171, "id"))), ((n$27172) !== false ? n$27172 : 0))));
        if (((msg$27i90 = $B["map-of"]("type", "playlist", "op", "list")), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i90)) : false))) {
          return false;
        } else {
          return note$27ui("Not connected to HazelFlix just now: try again in a moment.");
        }
      } else {
        return false;
      }
    });
    ((handler$27i91 = function (text, m) {
      let what$27173;
      (what$27173 = pending$27playlist);
      if ((what$27173) !== false) {
        return choose$27ui("Add to a playlist", $B["append"](choices$27playlist(what$27173, $B["map-ref"](m, "playlists", $B["vector"]()), ($B["vector-length"]($B["map-ref"](m, "playlists", $B["vector"]())) - 1), null), $listFromEnd($B["cons"]("New playlist\xe2\x80\xa6", function () {
          return new_playlist$27playlist(what$27173);
        }))));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "playlists", $B["append"]($B["map-ref"](handlers$27socket, "playlists", null), $listFromEnd(handler$27i91)))));
    ((handler$27i92 = function (text, m) {
      (pending$27playlist = false);
      return note$27ui($B["string-append"]((($B["map-ref"](m, "n", 1) === 1) ? "Added to " : $B["string-append"]($B["number->string"]($B["map-ref"](m, "n", 1)), " added to ")), $B["string-append"]($B["map-ref"](m, "name", ""), ".")));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "playlist-added", $B["append"]($B["map-ref"](handlers$27socket, "playlist-added", null), $listFromEnd(handler$27i92)))));
    (save$27174 = by_id$27dom("player-save"));
    if ((save$27174) !== false) {
      return on$27dom(save$27174, click$27dom, function (e) {
        let msg$27i93, name$27175, queue$27176;
        (name$27175 = ask$27page("The playlist's name", ""));
        (queue$27176 = queue_now$27player);
        if (((name$27175) !== false ? (queue$27176 > 0) : false)) {
          (msg$27i93 = $B["map-of"]("type", "playlist", "op", "new", "name", name$27175, "what", "queue", "id", queue$27176));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i93));
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
    let buttons$27177, each$27178;
    (query_has$3f$27page("popout") ? ((buttons$27177 = query_all$27dom("[data-popout]")), (each$27178 = function (i) {
      for (;;) {
        if ((i < $B["vector-length"](buttons$27177))) {
          set_hidden$21$27dom($B["vector-ref"](buttons$27177, i), true);
          const $t0 = (i + 1);
          i = $t0;
          continue;
        } else {
          return false;
        }
      }
    }), each$27178(0)) : false);
    return on_document$27dom(click$27dom, function (e) {
      let b$27179, q$27182, queue$27180, w$27181;
      (b$27179 = closest_of$27dom(e, "[data-popout]"));
      if ((b$27179) !== false) {
        (queue$27180 = ((q$27182 = queue_now$27player), ((q$27182 > 0) ? q$27182 : $B["map-ref"](self$27socket, "queue", 0))));
        (w$27181 = open_window$27page($B["string-append"]("/music/player?popout=1", ((queue$27180 > 0) ? $B["string-append"]("&queue=", $B["number->string"](queue$27180)) : "")), "hazelflix-player", "popup,width=460,height=780"));
        prevent_default$21$27dom(e);
        if ((w$27181 === false)) {
          return alert$21$27page("The browser didn't open the window: allow pop-ups for HazelFlix.");
        } else {
          focus_window$21$27page(w$27181);
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
  (number_of$27film = function (e, name) {
    let n$27183;
    (n$27183 = $B["string->number"](data_of$27dom(e, name)));
    if ((n$27183) !== false) {
      return $theReal((n$27183 + 0.0));
    } else {
      return 0.0;
    }
  });
  (film_plays$27film = function () {
    let video$27184;
    (video$27184 = media_by_id$27media("player"));
    if ((video$27184) !== false) {
      return plays$27film(video$27184);
    } else {
      return false;
    }
  });
  (plays$27film = function (video) {
    let dragging$27200, duration$27188, f$27191, file$27186, film$27185, format$27187, live$27189, offset$27190, position$27192, report$27193, seek$27198, show$27201, start$27196, time$27199;
    (film$27185 = data_of$27dom(video, "film"));
    (file$27186 = data_of$27dom(video, "file"));
    (format$27187 = ((f$27191 = data_of$27dom(video, "format")), ($B["equal?"](f$27191, "") ? "0" : f$27191)));
    (duration$27188 = number_of$27film(video, "duration"));
    (live$27189 = $B["equal?"](data_of$27dom(video, "live"), "1"));
    (offset$27190 = (live$27189 ? number_of$27film(video, "start") : 0.0));
    (position$27192 = function () {
      return (offset$27190 + media_time$27media(video));
    });
    (report$27193 = function (going) {
      let at$27194, length$27195, msg$27i96, x$27i94, x$27i95;
      (at$27194 = ((x$27i94 = position$27192()), ($B["round"]((10.0 * x$27i94)) / 10.0)));
      (length$27195 = ((x$27i95 = ((duration$27188 > 0.0) ? duration$27188 : media_duration$27media(video))), ($B["round"]((10.0 * x$27i95)) / 10.0)));
      if (((going === false) ? ((msg$27i96 = $B["map-of"]("type", "progress", "film", $B["string->number"](film$27185), "file", $B["string->number"](file$27186), "position", at$27194, "duration", length$27195)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i96)) : false)) : false)) {
        return false;
      } else {
        return post_form$21$27fetch("/progress", $B["string-append"]("film=", encode_component$27page(film$27185), "&file=", encode_component$27page(file$27186), "&position=", $realText(at$27194), "&duration=", $realText(length$27195)));
      }
    });
    ((live$27189 === false) ? ((start$27196 = number_of$27film(video, "start")), ((start$27196 > 0.0) ? on_once$27dom(video, loadedmetadata$27media, function (e) {
      return seek$21$27media(video, start$27196);
    }) : false)) : false);
    every$27page(10000, function () {
      if (media_paused$3f$27media(video)) {
        return false;
      } else {
        return report$27193(false);
      }
    });
    on$27dom(video, pause$27media, function (e) {
      return report$27193(false);
    });
    on$27dom(video, ended$27media, function (e) {
      let next$27197;
      report$27193(false);
      (next$27197 = data_of$27dom(video, "next"));
      if ($B["equal?"](next$27197, "")) {
        return false;
      } else {
        return after$27page(1500, function () {
          return go$21$27page(next$27197);
        });
      }
    });
    on_window$27page(pagehide$27page, function (e) {
      return report$27193(true);
    });
    if (live$27189) {
      (seek$27198 = by_id$27dom("live-seek"));
      (time$27199 = by_id$27dom("live-time"));
      (dragging$27200 = false);
      (show$27201 = function (s) {
        if ((time$27199) !== false) {
          return set_text$21$27dom(time$27199, $B["string-append"](clock$27clock(s), " / ", clock$27clock(duration$27188)));
        } else {
          return false;
        }
      });
      on$27dom(video, timeupdate$27media, function (e) {
        (((seek$27198) !== false ? (dragging$27200 === false) : false) ? set_field$21$27dom(seek$27198, $B["number->string"]($B["exact"]($B["floor"](position$27192())))) : false);
        return show$27201(position$27192());
      });
      if ((seek$27198) !== false) {
        on$27dom(seek$27198, input$27dom, function (e) {
          (dragging$27200 = true);
          return show$27201(number_of_field$27film(seek$27198));
        });
        return on$27dom(seek$27198, change$27dom, function (e) {
          (dragging$27200 = false);
          (offset$27190 = number_of_field$27film(seek$27198));
          const $c0 = $B["floor"](offset$27190);
          if (!Number.isInteger($c0)) throw $notInteger;
          set_source$21$27media(video, $B["string-append"]("/live/", file$27186, "?t=", $B["number->string"]($c0), ($B["equal?"](format$27187, "0") ? "" : $B["string-append"]("&format=", format$27187))));
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
    let n$27202;
    (n$27202 = $B["string->number"](value_of$27dom(e)));
    if ((n$27202) !== false) {
      return $theReal((n$27202 + 0.0));
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
    let from$27204, me$27203;
    (me$27203 = $B["string-append"](browser_id$27socket(), $B["string-append"](".", tab$27socket)));
    (from$27204 = function (i) {
      for (;;) {
        if ((i < 0)) {
          return null;
        } else {
          if ($B["equal?"]($B["map-ref"]($B["vector-ref"](targets$27where, i), "id", ""), me$27203)) {
            const $t0 = (i - 1);
            i = $t0;
            continue;
          } else {
            return $B["cons"]($B["vector-ref"](targets$27where, i), from$27204((i - 1)));
          }
        }
      }
    });
    return $B["reverse"](from$27204(($B["vector-length"](targets$27where) - 1)));
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
    let msg$27i97, this$27205;
    if (((msg$27i97 = $B["map-of"]("type", "play", "target", $B["map-ref"](t, "id", ""), "href", href)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i97)) : false))) {
      (this$27205 = (sent$27where + 1));
      (sent$27where = this$27205);
      (waiting$27where = this$27205);
      return after$27page(5000, function () {
        if ((waiting$27where === this$27205)) {
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
      let t$27206;
      if ($B["null?"](l)) {
        return null;
      } else {
        (t$27206 = $B["car"](l));
        return $B["cons"]($B["cons"]($B["map-ref"](t$27206, "name", ""), function () {
          return send_to$27where(t$27206, href);
        }), choices($B["cdr"](l)));
      }
    });
    return choose$27ui("Play where?", $B["cons"]($B["cons"]("This browser", function () {
      return go$21$27page(href);
    }), choices(there)));
  });
  (ask_which$27where = function (href, there) {
    let msg$27i98, n$27207;
    (n$27207 = (asked$27where + 1));
    (asked$27where = n$27207);
    (asked_href$27where = href);
    if (((msg$27i98 = $B["map-of"]("type", "can-play", "n", n$27207, "href", href)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i98)) : false))) {
      return after$27page(1000, function () {
        if ((asked$27where === n$27207)) {
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
    let b$27208$27i100, b$27208$27i99;
    if ($B["string-prefix?"]("/play/", href)) {
      if ((6 < $B["string-length"](href))) {
        (b$27208$27i99 = $B["byte-ref"](href, 6));
        if ((b$27208$27i99 >= 48)) {
          return (b$27208$27i99 <= 57);
        } else {
          return false;
        }
      } else {
        return false;
      }
    } else {
      if ($B["string-prefix?"]("/watch/", href)) {
        if ((7 < $B["string-length"](href))) {
          (b$27208$27i100 = $B["byte-ref"](href, 7));
          if ((b$27208$27i100 >= 48)) {
            return (b$27208$27i100 <= 57);
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
    let handler$27i101, handler$27i102, handler$27i103, handler$27i104;
    ((handler$27i101 = function (text, m) {
      return (targets$27where = $theVector($B["map-ref"](m, "targets", $B["vector"]())));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "targets", $B["append"]($B["map-ref"](handlers$27socket, "targets", null), $listFromEnd(handler$27i101)))));
    ((handler$27i102 = function (text, m) {
      if ((waiting$27where > 0)) {
        (waiting$27where = 0);
        return go$21$27page($B["string-append"]("/remote?target=", encode_component$27page($B["map-ref"](m, "target", ""))));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "played", $B["append"]($B["map-ref"](handlers$27socket, "played", null), $listFromEnd(handler$27i102)))));
    ((handler$27i103 = function (text, m) {
      if ((waiting$27where > 0)) {
        (waiting$27where = 0);
        return alert$21$27page($B["map-ref"](m, "why", ""));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "failed", $B["append"]($B["map-ref"](handlers$27socket, "failed", null), $listFromEnd(handler$27i103)))));
    ((handler$27i104 = function (text, m) {
      let able$27209, href$27210;
      if (((asked$27where > 0) ? ($B["map-ref"](m, "n", 0) === asked$27where) : false)) {
        (able$27209 = only_able$27where(other_screens$27where(), $B["map-ref"](m, "targets", $B["vector"]())));
        (href$27210 = asked_href$27where);
        (asked$27where = 0);
        if ($B["null?"](able$27209)) {
          return go$21$27page(href$27210);
        } else {
          return ask_where$27where(href$27210, able$27209);
        }
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "can-play", $B["append"]($B["map-ref"](handlers$27socket, "can-play", null), $listFromEnd(handler$27i104)))));
    return on_document$27dom(click$27dom, function (e) {
      let a$27211, href$27212, there$27213;
      (a$27211 = closest_of$27dom(e, "a[href]"));
      if (((a$27211) !== false ? ((default_prevented$3f$27dom(e) === false) ? (plain_click$3f$27dom(e) ? (by_id$27dom("ready") === false) : false) : false) : false)) {
        (href$27212 = attribute_of$27dom(a$27211, "href"));
        (there$27213 = other_screens$27where());
        if ((player_link$3f$27where(href$27212) ? (($B["null?"](there$27213) === false) ? dialogs$3f$27dom() : false) : false)) {
          prevent_default$21$27dom(e);
          return ask_which$27where(href$27212, there$27213);
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
  });
  (text$21$27ready = function (id, text) {
    let e$27214;
    (e$27214 = by_id$27dom(id));
    if ((e$27214) !== false) {
      return set_text$21$27dom(e$27214, text);
    } else {
      return false;
    }
  });
  (ready_to_play$27ready = function () {
    let ready$27215, video$27216;
    (ready$27215 = by_id$27dom("ready"));
    (video$27216 = media_by_id$27media("screen"));
    if ((((ready$27215) !== false ? video$27216 : false)) !== false) {
      return screen_plays$27ready(video$27216);
    } else {
      return false;
    }
  });
  (screen_plays$27ready = function (video) {
    let card$27220, duration$27229, film$27223, film$27i129, films$27221, handler$27i135, handler$27i142, handler$27i145, handler$27i161, item$27222, loaded$27233, on_load$27i130, on_sleep$27i132, on_wake$27i131, player$27225, reached$27224, report$27231, screen$27219, show_name$27228, start$27217, started$27227, state$27230, still$27226, stirred$27232, stop$27234, wait$27218;
    (start$27217 = by_id$27dom("ready-start"));
    (wait$27218 = by_id$27dom("ready-wait"));
    (screen$27219 = by_id$27dom("ready-screen"));
    (card$27220 = by_id$27dom("ready-card"));
    (films$27221 = $B["map-of"]());
    (item$27222 = false);
    (film$27223 = false);
    (reached$27224 = 0.0);
    (player$27225 = false);
    (still$27226 = 0);
    (started$27227 = function () {
      return player$27225;
    });
    (show_name$27228 = function () {
      let name$27235;
      (name$27235 = $B["map-ref"](self$27socket, "name", ""));
      if ($B["equal?"](name$27235, "")) {
        return false;
      } else {
        text$21$27ready("ready-hint-name", $B["string-append"]("\xe2\x80\x9c", name$27235, "\xe2\x80\x9d"));
        return text$21$27ready("ready-name", ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") ? $B["string-append"]("This screen is ", name$27235, ".") : $B["string-append"]("This screen is ", name$27235, ": set it to Play in Settings, Browsers, so others can send to it.")));
      }
    });
    (duration$27229 = function () {
      if ($B["map?"](film$27223)) {
        return real_of$27said($B["map-ref"](film$27223, "duration", 0));
      } else {
        if ($B["map?"](item$27222)) {
          return real_of$27said($B["map-ref"](item$27222, "duration", 0));
        } else {
          return 0.0;
        }
      }
    });
    (state$27230 = function () {
      let msg$27i111, r$27i105, x$27i106, x$27i107, x$27i108, x$27i109, x$27i110;
      (msg$27i111 = $B["map-of"]("type", "state", "playing", ($B["map?"](item$27222) ? true : false), "paused", media_paused$3f$27media(video), "position", ((x$27i106 = ((r$27i105 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i105))()), $B["exact"]($B["floor"](real_of$27said(x$27i106)))), "duration", ((x$27i107 = duration$27229()), $B["exact"]($B["floor"](real_of$27said(x$27i107)))), "title", ($B["map?"](item$27222) ? ((x$27i108 = $B["map-ref"](item$27222, "title", "")), ($B["string?"](x$27i108) ? x$27i108 : ($B["number?"](x$27i108) ? $B["number->string"](x$27i108) : ""))) : ""), "label", text_of$27dom(by_id$27dom("ready-label")), "poster", ($B["map?"](film$27223) ? ((x$27i109 = $B["map-ref"](film$27223, "poster", "")), ($B["string?"](x$27i109) ? x$27i109 : ($B["number?"](x$27i109) ? $B["number->string"](x$27i109) : ""))) : ($B["map?"](item$27222) ? ((x$27i110 = $B["map-ref"](item$27222, "art", "")), ($B["string?"](x$27i110) ? x$27i110 : ($B["number?"](x$27i110) ? $B["number->string"](x$27i110) : ""))) : "")), "volume", volume$27media(video), "muted", muted$3f$27media(video), "subtitles", ($B["map?"](film$27223) ? $B["map-ref"](film$27223, "subtitles", 0) : 0), "subtitlesOn", subtitles_showing$3f$27media(video), "next", ($B["map?"](film$27223) ? $B["map-ref"](film$27223, "next", 0) : 0)));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i111));
      } else {
        return false;
      }
    });
    (report$27231 = function () {
      let msg$27i114, x$27i112, x$27i113;
      if (($B["map?"](film$27223) ? (reached$27224 > 0.0) : false)) {
        (msg$27i114 = $B["map-of"]("type", "progress", "film", $B["map-ref"](film$27223, "film", 0), "file", $B["map-ref"](film$27223, "file", 0), "position", ((x$27i112 = reached$27224), ($B["round"]((10.0 * x$27i112)) / 10.0)), "duration", ((x$27i113 = real_of$27said($B["map-ref"](film$27223, "duration", 0))), ($B["round"]((10.0 * x$27i113)) / 10.0))));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i114));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    (stirred$27232 = function () {
      remove_class$21$27dom(screen$27219, "still");
      cancel_timer$21$27page(still$27226);
      return (still$27226 = after$27page(3000, function () {
        return add_class$21$27dom(screen$27219, "still");
      }));
    });
    (loaded$27233 = function (i, p) {
      let album$27237, art$27243, artist$27236, each$27239, each$27240, or$27value$27242, tracks$27238, x$27i115, x$27i116, x$27i117, x$27i118, x$27i121, x$27i122, x$27i123, x$27i124, x$27i125;
      report$27231();
      (item$27222 = i);
      (film$27223 = p);
      (reached$27224 = 0.0);
      text$21$27ready("ready-title", ((x$27i115 = $B["map-ref"](i, "title", "")), ($B["string?"](x$27i115) ? x$27i115 : ($B["number?"](x$27i115) ? $B["number->string"](x$27i115) : ""))));
      text$21$27ready("ready-label", ($B["map?"](p) ? ((x$27i116 = $B["map-ref"](p, "label", "")), ($B["string?"](x$27i116) ? x$27i116 : ($B["number?"](x$27i116) ? $B["number->string"](x$27i116) : ""))) : ((artist$27236 = ((x$27i117 = $B["map-ref"](i, "artist", "")), ($B["string?"](x$27i117) ? x$27i117 : ($B["number?"](x$27i117) ? $B["number->string"](x$27i117) : "")))), (album$27237 = ((x$27i118 = $B["map-ref"](i, "album", "")), ($B["string?"](x$27i118) ? x$27i118 : ($B["number?"](x$27i118) ? $B["number->string"](x$27i118) : "")))), ($B["equal?"](artist$27236, "") ? album$27237 : ($B["equal?"](album$27237, "") ? artist$27236 : $B["string-append"](artist$27236, " \xc2\xb7 ", album$27237))))));
      text$21$27ready("ready-time", "");
      ((tracks$27238 = query_all_in$27dom(video, "track")), ((each$27239 = function (n) {
        for (;;) {
          if ((n < $B["vector-length"](tracks$27238))) {
            remove$21$27dom($B["vector-ref"](tracks$27238, n));
            const $t0 = (n + 1);
            n = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27239(0)));
      ($B["map?"](p) ? ((each$27240 = function (n) {
        let t$27241, x$27i119, x$27i120;
        for (;;) {
          if ((n < ((x$27i119 = $B["map-ref"](p, "subtitles", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i119)))))) {
            (t$27241 = make_element$27dom("track"));
            set_attribute$21$27dom(t$27241, "kind", "subtitles");
            set_attribute$21$27dom(t$27241, "srclang", "en");
            set_attribute$21$27dom(t$27241, "src", $B["string-append"]("/subs/", ((x$27i120 = $B["map-ref"](p, "file", 0)), ($B["string?"](x$27i120) ? x$27i120 : ($B["number?"](x$27i120) ? $B["number->string"](x$27i120) : ""))), "/", $B["number->string"](n)));
            ((n === 0) ? set_attribute$21$27dom(t$27241, "default", "") : false);
            append$21$27dom(video, t$27241);
            const $t0 = (n + 1);
            n = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27240(0)) : false);
      set_poster$21$27media(video, ($B["map?"](p) ? ((x$27i121 = $B["map-ref"](p, "poster", "")), ($B["string?"](x$27i121) ? x$27i121 : ($B["number?"](x$27i121) ? $B["number->string"](x$27i121) : ""))) : ""));
      set_hidden$21$27dom(card$27220, ((or$27value$27242 = $B["map?"](p)), (or$27value$27242 ? or$27value$27242 : $B["equal?"]($B["map-ref"](i, "kind", ""), "video"))));
      text$21$27ready("ready-card-title", ((x$27i122 = $B["map-ref"](i, "title", "")), ($B["string?"](x$27i122) ? x$27i122 : ($B["number?"](x$27i122) ? $B["number->string"](x$27i122) : ""))));
      text$21$27ready("ready-card-artist", ((x$27i123 = $B["map-ref"](i, "artist", "")), ($B["string?"](x$27i123) ? x$27i123 : ($B["number?"](x$27i123) ? $B["number->string"](x$27i123) : ""))));
      text$21$27ready("ready-card-album", ((x$27i124 = $B["map-ref"](i, "album", "")), ($B["string?"](x$27i124) ? x$27i124 : ($B["number?"](x$27i124) ? $B["number->string"](x$27i124) : ""))));
      ((art$27243 = ((x$27i125 = $B["map-ref"](i, "art", "")), ($B["string?"](x$27i125) ? x$27i125 : ($B["number?"](x$27i125) ? $B["number->string"](x$27i125) : "")))), set_style$21$27dom(by_id$27dom("ready-card-back"), "background-image", ($B["equal?"](art$27243, "") ? "none" : $B["string-append"]("url(\"", art$27243, "\")"))));
      stirred$27232();
      return state$27230();
    });
    (stop$27234 = function () {
      let r$27i126, r$27i127, r$27i128;
      if (((r$27i126 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i126))()) {
        ((r$27i127 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i127))("pause", null);
        return ((r$27i128 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r$27i128))();
      } else {
        return false;
      }
    });
    (player$27225 = start_player$27player(screen$27219, ((film$27i129 = function (i) {
      return $B["map-ref"](films$27221, $B["map-ref"](i, "file", 0), false);
    }), (on_load$27i130 = loaded$27233), (on_wake$27i131 = function () {
      set_hidden$21$27dom(start$27217, true);
      set_hidden$21$27dom(wait$27218, true);
      set_hidden$21$27dom(screen$27219, false);
      stirred$27232();
      return false;
    }), (on_sleep$27i132 = function () {
      report$27231();
      (item$27222 = false);
      (film$27223 = false);
      set_hidden$21$27dom(screen$27219, true);
      set_hidden$21$27dom(wait$27218, (hidden$3f$27dom(start$27217) === false));
      state$27230();
      return false;
    }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", true, false, film$27i129, on_load$27i130, on_wake$27i131, on_sleep$27i132))));
    on$27dom(by_id$27dom("ready-go"), click$27dom, function (e) {
      play$21$27media(video);
      pause$21$27media(video);
      fullscreen$21$27page();
      set_hidden$21$27dom(start$27217, true);
      set_hidden$21$27dom(wait$27218, false);
      add_class$21$27dom(body$27dom(), "ready-on");
      show_name$27228();
      return again$27intro();
    });
    on$27dom(by_id$27dom("ready-home"), click$27dom, function (e) {
      return stop$27234();
    });
    on$27dom(video, timeupdate$27media, function (e) {
      let at$27244, length$27245, r$27i133;
      (at$27244 = ((r$27i133 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i133))());
      (length$27245 = duration$27229());
      (($B["map?"](item$27222) ? (media_time$27media(video) > 0.0) : false) ? (reached$27224 = at$27244) : false);
      return text$21$27ready("ready-time", (($B["map?"](item$27222) ? (length$27245 > 0.0) : false) ? $B["string-append"](clock$27clock(at$27244), " / ", clock$27clock((length$27245 - at$27244))) : ""));
    });
    on$27dom(video, ended$27media, function (e) {
      let q$27246, r$27i134;
      (q$27246 = ((r$27i134 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r$27i134))());
      if (((q$27246) !== false ? (($B["map-ref"](q$27246, "at", 0) >= ($B["vector-length"]($B["map-ref"](q$27246, "items", $B["vector"]())) - 1)) ? $B["equal?"]($B["map-ref"](q$27246, "repeat", ""), "off") : false) : false)) {
        report$27231();
        return after$27page(500, stop$27234);
      } else {
        return false;
      }
    });
    on$27dom(screen$27219, mousemove$27dom, function (e) {
      return stirred$27232();
    });
    on$27dom(screen$27219, pointerdown$27dom, function (e) {
      return stirred$27232();
    });
    on$27dom(screen$27219, touchstart$27dom, function (e) {
      return stirred$27232();
    });
    on_document$27dom(keydown$27dom, function (e) {
      if (hidden$3f$27dom(screen$27219)) {
        return false;
      } else {
        return stirred$27232();
      }
    });
    on$27dom(video, play$27media, function (e) {
      return state$27230();
    });
    on$27dom(video, pause$27media, function (e) {
      state$27230();
      return report$27231();
    });
    on$27dom(video, volumechange$27media, function (e) {
      return state$27230();
    });
    on$27dom(video, seeked$27media, function (e) {
      return state$27230();
    });
    every$27page(1000, function () {
      if (($B["map?"](item$27222) ? (media_paused$3f$27media(video) === false) : false)) {
        return state$27230();
      } else {
        return false;
      }
    });
    every$27page(10000, function () {
      if (($B["map?"](item$27222) ? (media_paused$3f$27media(video) === false) : false)) {
        return report$27231();
      } else {
        return false;
      }
    });
    ((handler$27i135 = function (text, m) {
      return show_name$27228();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i135)))));
    ((handler$27i142 = function (text, p) {
      let r$27i136, r$27i137, r$27i139, r$27i140, x$27i138, x$27i141;
      (films$27221 = $B["map-set"](films$27221, $B["map-ref"](p, "file", 0), p));
      if ((((r$27i136 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i136))() ? (((r$27i137 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i137))() === ((x$27i138 = $B["map-ref"](p, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i138))))) : false)) {
        return ((r$27i139 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 8, r$27i139))();
      } else {
        return ((r$27i140 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i140))(((x$27i141 = $B["map-ref"](p, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i141)))));
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "play", $B["append"]($B["map-ref"](handlers$27socket, "play", null), $listFromEnd(handler$27i142)))));
    ((handler$27i145 = function (text, m) {
      let r$27i143, x$27i144;
      return ((r$27i143 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i143))(((x$27i144 = $B["map-ref"](m, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i144)))));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "music", $B["append"]($B["map-ref"](handlers$27socket, "music", null), $listFromEnd(handler$27i145)))));
    (handler$27i161 = function (text, m) {
      let at$27249, c$27247, or$27value$27250, or$27value$27251, or$27value$27253, q$27248, r$27i146, r$27i147, r$27i148, r$27i151, r$27i152, r$27i154, r$27i156, r$27i158, r$27i159, r$27i160, v$27252, x$27i149, x$27i150, x$27i153, x$27i155, x$27i157;
      (c$27247 = $B["map-ref"](m, "command", ""));
      (q$27248 = ((r$27i146 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r$27i146))());
      (at$27249 = ((r$27i147 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i147))());
      ($B["equal?"](c$27247, "stop") ? stop$27234() : ((((r$27i148 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i148))() === false) ? false : (((or$27value$27250 = $B["equal?"](c$27247, "toggle")), (or$27value$27250 ? or$27value$27250 : ((or$27value$27251 = ($B["equal?"](c$27247, "play") ? ((q$27248) !== false ? ((x$27i149 = $B["map-ref"](q$27248, "paused", false)), ((x$27i149) !== false ? (((x$27i149 === $sym("null")) === false) ? (($B["equal?"](x$27i149, 0) === false) ? ($B["equal?"](x$27i149, "") === false) : false) : false) : false)) : false) : false)), (or$27value$27251 ? or$27value$27251 : ($B["equal?"](c$27247, "pause") ? ((q$27248) !== false ? (((x$27i150 = $B["map-ref"](q$27248, "paused", false)), ((x$27i150) !== false ? (((x$27i150 === $sym("null")) === false) ? (($B["equal?"](x$27i150, 0) === false) ? ($B["equal?"](x$27i150, "") === false) : false) : false) : false)) === false) : false) : false))))) ? ((r$27i151 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i151))("toggle", null) : ($B["equal?"](c$27247, "back") ? ((r$27i152 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i152))("seek", $listFromEnd($B["cons"]("value", ((v$27252 = ((x$27i153 = (at$27249 - 10.0)), $B["exact"]($B["floor"](real_of$27said(x$27i153))))), ((v$27252 > 0) ? v$27252 : 0))))) : ($B["equal?"](c$27247, "forward") ? ((r$27i154 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i154))("seek", $listFromEnd($B["cons"]("value", ((x$27i155 = (at$27249 + 30.0)), $B["exact"]($B["floor"](real_of$27said(x$27i155))))))) : ($B["equal?"](c$27247, "seek") ? ((r$27i156 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i156))("seek", $listFromEnd($B["cons"]("value", ((x$27i157 = $B["map-ref"](m, "value", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i157))))))) : ($B["equal?"](c$27247, "next") ? ((r$27i158 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i158))("next", null) : ($B["equal?"](c$27247, "prev") ? ((r$27i159 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i159))("prev", null) : ($B["equal?"](c$27247, "volume-down") ? set_volume$21$27media(video, (volume$27media(video) - 0.10000000000000001)) : ($B["equal?"](c$27247, "volume-up") ? (set_muted$21$27media(video, false), set_volume$21$27media(video, (volume$27media(video) + 0.10000000000000001))) : ($B["equal?"](c$27247, "mute") ? set_muted$21$27media(video, (muted$3f$27media(video) === false)) : ($B["equal?"](c$27247, "subtitles") ? show_subtitles$21$27media(video, (subtitles_showing$3f$27media(video) ? -1 : 0)) : false))))))))))));
      if ((((or$27value$27253 = $B["equal?"](c$27247, "stop")), (or$27value$27253 ? or$27value$27253 : ((r$27i160 = started$27227()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i160))()))) !== false) {
        return state$27230();
      } else {
        return false;
      }
    });
    return (handlers$27socket = $B["map-set"](handlers$27socket, "control", $B["append"]($B["map-ref"](handlers$27socket, "control", null), $listFromEnd(handler$27i161))));
  });
  (hide$21$27remote = function (id, hidden) {
    let e$27254;
    (e$27254 = by_id$27dom(id));
    if ((e$27254) !== false) {
      return set_hidden$21$27dom(e$27254, hidden);
    } else {
      return false;
    }
  });
  (text$21$27remote = function (id, text) {
    let e$27255;
    (e$27255 = by_id$27dom(id));
    if ((e$27255) !== false) {
      return set_text$21$27dom(e$27255, text);
    } else {
      return false;
    }
  });
  (as_queue$27remote = $B["map-of"]("toggle", "toggle", "play", "toggle", "pause", "toggle", "next", "next", "prev", "prev", "seek", "seek", "back", "seek", "forward", "seek"));
  (remote_controls$27remote = function () {
    let remote$27256;
    (remote$27256 = by_id$27dom("remote"));
    if ((remote$27256) !== false) {
      return controls$27remote(remote$27256);
    } else {
      return false;
    }
  });
  (controls$27remote = function (remote) {
    let button$27329, chosen$27257, command$27279, dragging$27258, find_playing$27271, from_queue$27268, handler$27i186, handler$27i189, handler$27i190, handler$27i191, has$3f$27272, list$27330, listed$27266, listing$27265, names$27259, names_of$27273, others$27269, picked$27260, playing$3f$27270, queue_of$27267, queue_row$27278, queue_shape$27277, queues$27262, render$27275, seek$27264, seek_value$27280, show_queue$27276, states$27261, tab$21$27274, tabs$27263;
    (chosen$27257 = data_of$27dom(remote, "target"));
    (dragging$27258 = false);
    (names$27259 = "");
    (picked$27260 = ($B["equal?"](data_of$27dom(remote, "target"), "") === false));
    (states$27261 = $B["map-of"]());
    (queues$27262 = $B["map-of"]());
    (tabs$27263 = by_id$27dom("remote-tabs"));
    (seek$27264 = by_id$27dom("remote-seek"));
    (listing$27265 = false);
    (listed$27266 = "");
    (queue_of$27267 = function (t) {
      let x$27i162;
      if (($B["map?"](t) ? (((x$27i162 = $B["map-ref"](t, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i162)))) > 0) : false)) {
        return $B["map-ref"](queues$27262, $B["map-ref"](t, "queue", 0), false);
      } else {
        return false;
      }
    });
    (from_queue$27268 = function (t) {
      let item$27282, kind$27283, or$27value$27285, paused$27284, q$27281, x$27i163, x$27i164, x$27i165, x$27i166, x$27i167, x$27i168;
      (q$27281 = queue_of$27267(t));
      if (((q$27281) !== false ? ($B["vector-length"]($B["map-ref"](q$27281, "items", $B["vector"]())) > 0) : false)) {
        (item$27282 = $B["vector-ref"]($B["map-ref"](q$27281, "items", $B["vector"]()), $B["map-ref"](q$27281, "at", 0)));
        (kind$27283 = $B["map-ref"](item$27282, "kind", ""));
        (paused$27284 = ((x$27i163 = $B["map-ref"](q$27281, "paused", false)), ((x$27i163) !== false ? (((x$27i163 === $sym("null")) === false) ? (($B["equal?"](x$27i163, 0) === false) ? ($B["equal?"](x$27i163, "") === false) : false) : false) : false)));
        if (((or$27value$27285 = $B["equal?"](kind$27283, "film")), (or$27value$27285 ? or$27value$27285 : $B["equal?"](kind$27283, "episode")))) {
          return false;
        } else {
          return $B["map-of"]("playing", true, "paused", paused$27284, "music", true, "title", ((x$27i164 = $B["map-ref"](item$27282, "title", "")), ($B["string?"](x$27i164) ? x$27i164 : ($B["number?"](x$27i164) ? $B["number->string"](x$27i164) : ""))), "label", ((x$27i165 = $B["map-ref"](item$27282, "artist", "")), ($B["string?"](x$27i165) ? x$27i165 : ($B["number?"](x$27i165) ? $B["number->string"](x$27i165) : ""))), "poster", ((x$27i166 = $B["map-ref"](item$27282, "art", "")), ($B["string?"](x$27i166) ? x$27i166 : ($B["number?"](x$27i166) ? $B["number->string"](x$27i166) : ""))), "next", 1, "subtitles", 0, "duration", ((x$27i167 = $B["map-ref"](item$27282, "duration", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i167)))), "position", ((x$27i168 = (real_of$27said($B["map-ref"](q$27281, "position", 0)) + (paused$27284 ? 0.0 : ((now_ms$27page() - real_of$27said($B["map-ref"](q$27281, "received", 0))) / 1000.0)))), $B["exact"]($B["floor"](real_of$27said(x$27i168)))), "queue", $B["map-ref"](q$27281, "id", 0));
        }
      } else {
        return false;
      }
    });
    (others$27269 = function () {
      return other_screens$27where();
    });
    (playing$3f$27270 = function (id) {
      let or$27value$27287, s$27286, x$27i169;
      (s$27286 = ((or$27value$27287 = from_queue$27268(screen_of$27where(id))), ((or$27value$27287) !== false ? or$27value$27287 : $B["map-ref"](states$27261, id, false))));
      if ((s$27286) !== false) {
        (x$27i169 = $B["map-ref"](s$27286, "playing", false));
        if ((x$27i169) !== false) {
          if (((x$27i169 === $sym("null")) === false)) {
            if (($B["equal?"](x$27i169, 0) === false)) {
              return ($B["equal?"](x$27i169, "") === false);
            } else {
              return false;
            }
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
    (find_playing$27271 = function (l) {
      for (;;) {
        if ($B["null?"](l)) {
          return false;
        } else {
          if (playing$3f$27270($B["map-ref"]($B["car"](l), "id", ""))) {
            return $B["car"](l);
          } else {
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      }
    });
    (has$3f$27272 = function (l, id) {
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
    (names_of$27273 = function (l) {
      if ($B["null?"](l)) {
        return "";
      } else {
        return $B["string-append"]($B["map-ref"]($B["car"](l), "id", ""), "\n", $B["map-ref"]($B["car"](l), "name", ""), "\n", names_of$27273($B["cdr"](l)));
      }
    });
    (tab$21$27274 = function (t) {
      let b$27288;
      (b$27288 = make_element$27dom("button"));
      set_attribute$21$27dom(b$27288, "type", "button");
      set_attribute$21$27dom(b$27288, "role", "tab");
      set_attribute$21$27dom(b$27288, "data-screen", $B["map-ref"](t, "id", ""));
      set_text$21$27dom(b$27288, $B["map-ref"](t, "name", ""));
      return append$21$27dom(tabs$27263, b$27288);
    });
    (render$27275 = function () {
      let buttons$27294, duration$27306, each$27293, each$27295, list$27289, now$27292, or$27value$27290, or$27value$27299, or$27value$27300, or$27value$27301, or$27value$27302, or$27value$27303, or$27value$27309, playing$27291, playing$27298, position$27307, poster$27304, q$27308, s$27297, src$27305, subtitles$27310, x$27i170, x$27i171, x$27i172, x$27i173, x$27i174, x$27i175, x$27i176, x$27i177, x$27i178, x$27i179;
      (list$27289 = others$27269());
      hide$21$27remote("remote-ready", ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") === false));
      hide$21$27remote("remote-none", ($B["null?"](list$27289) === false));
      (((has$3f$27272(list$27289, chosen$27257)) !== false ? ((or$27value$27290 = picked$27260), (or$27value$27290 ? or$27value$27290 : playing$3f$27270(chosen$27257))) : false) ? false : ((playing$27291 = find_playing$27271(list$27289)), (chosen$27257 = $theString(((playing$27291) !== false ? $B["map-ref"](playing$27291, "id", "") : ((has$3f$27272(list$27289, chosen$27257)) !== false ? chosen$27257 : ($B["null?"](list$27289) ? "" : $B["map-ref"]($B["car"](list$27289), "id", ""))))))));
      ((now$27292 = names_of$27273(list$27289)), ($B["equal?"](now$27292, names$27259) ? false : ((names$27259 = now$27292), clear$21$27dom(tabs$27263), ((each$27293 = function (l) {
        for (;;) {
          if ($B["null?"](l)) {
            return false;
          } else {
            tab$21$27274($B["car"](l));
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      }), each$27293(list$27289)))));
      ((buttons$27294 = query_all$27dom("#remote-tabs [data-screen]")), (each$27295 = function (i) {
        let b$27296;
        for (;;) {
          if ((i < $B["vector-length"](buttons$27294))) {
            (b$27296 = $B["vector-ref"](buttons$27294, i));
            set_attribute$21$27dom(b$27296, "aria-selected", ($B["equal?"](data_of$27dom(b$27296, "screen"), chosen$27257) ? "true" : "false"));
            const $t0 = (i + 1);
            i = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27295(0));
      (s$27297 = ((or$27value$27299 = from_queue$27268(screen_of$27where(chosen$27257))), ((or$27value$27299) !== false ? or$27value$27299 : $B["map-ref"](states$27261, chosen$27257, false))));
      (playing$27298 = ((s$27297) !== false ? ((x$27i170 = $B["map-ref"](s$27297, "playing", false)), ((x$27i170) !== false ? (((x$27i170 === $sym("null")) === false) ? (($B["equal?"](x$27i170, 0) === false) ? ($B["equal?"](x$27i170, "") === false) : false) : false) : false)) : false));
      hide$21$27remote("remote-now", (playing$27298 === false));
      hide$21$27remote("remote-idle", ((or$27value$27300 = $B["equal?"](chosen$27257, "")), (or$27value$27300 ? or$27value$27300 : ((or$27value$27301 = playing$27298), (or$27value$27301 ? or$27value$27301 : $B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play"))))));
      hide$21$27remote("remote-idle-ready", ((or$27value$27302 = $B["equal?"](chosen$27257, "")), (or$27value$27302 ? or$27value$27302 : ((or$27value$27303 = playing$27298), (or$27value$27303 ? or$27value$27303 : ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") === false))))));
      if (playing$27298) {
        (poster$27304 = by_id$27dom("remote-poster"));
        (src$27305 = ((x$27i171 = $B["map-ref"](s$27297, "poster", "")), ($B["string?"](x$27i171) ? x$27i171 : ($B["number?"](x$27i171) ? $B["number->string"](x$27i171) : ""))));
        (duration$27306 = ((x$27i172 = $B["map-ref"](s$27297, "duration", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i172)))));
        (position$27307 = ((x$27i173 = $B["map-ref"](s$27297, "position", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i173)))));
        (q$27308 = queue_of$27267(screen_of$27where(chosen$27257)));
        ((poster$27304) !== false ? (set_hidden$21$27dom(poster$27304, $B["equal?"](src$27305, "")), ((($B["equal?"](src$27305, "") === false) ? ($B["equal?"](attribute_of$27dom(poster$27304, "src"), src$27305) === false) : false) ? set_attribute$21$27dom(poster$27304, "src", src$27305) : false)) : false);
        text$21$27remote("remote-title", ((x$27i174 = $B["map-ref"](s$27297, "title", "")), ($B["string?"](x$27i174) ? x$27i174 : ($B["number?"](x$27i174) ? $B["number->string"](x$27i174) : ""))));
        text$21$27remote("remote-label", ((x$27i175 = $B["map-ref"](s$27297, "label", "")), ($B["string?"](x$27i175) ? x$27i175 : ($B["number?"](x$27i175) ? $B["number->string"](x$27i175) : ""))));
        (dragging$27258 ? false : (set_attribute$21$27dom(seek$27264, "max", $B["number->string"](duration$27306)), set_field$21$27dom(seek$27264, $B["number->string"](position$27307)), text$21$27remote("remote-time", $B["string-append"](clock$27clock((0.0 + position$27307)), " / ", clock$27clock((0.0 + duration$27306))))));
        hide$21$27remote("remote-play", (((x$27i176 = $B["map-ref"](s$27297, "paused", false)), ((x$27i176) !== false ? (((x$27i176 === $sym("null")) === false) ? (($B["equal?"](x$27i176, 0) === false) ? ($B["equal?"](x$27i176, "") === false) : false) : false) : false)) === false));
        hide$21$27remote("remote-pause", ((x$27i177 = $B["map-ref"](s$27297, "paused", false)), ((x$27i177) !== false ? (((x$27i177 === $sym("null")) === false) ? (($B["equal?"](x$27i177, 0) === false) ? ($B["equal?"](x$27i177, "") === false) : false) : false) : false)));
        hide$21$27remote("remote-next-slot", ((q$27308) !== false ? (((or$27value$27309 = ($B["map-ref"](q$27308, "at", 0) < ($B["vector-length"]($B["map-ref"](q$27308, "items", $B["vector"]())) - 1))), (or$27value$27309 ? or$27value$27309 : $B["equal?"]($B["map-ref"](q$27308, "repeat", ""), "all"))) === false) : (((x$27i178 = $B["map-ref"](s$27297, "next", false)), ((x$27i178) !== false ? (((x$27i178 === $sym("null")) === false) ? (($B["equal?"](x$27i178, 0) === false) ? ($B["equal?"](x$27i178, "") === false) : false) : false) : false)) === false)));
        hide$21$27remote("remote-prev-slot", (((q$27308) !== false ? ($B["vector-length"]($B["map-ref"](q$27308, "items", $B["vector"]())) > 0) : false) === false));
        ((subtitles$27310 = query_in$27dom(remote, "[data-command=subtitles]")), ((subtitles$27310) !== false ? set_hidden$21$27dom(subtitles$27310, (((x$27i179 = $B["map-ref"](s$27297, "subtitles", false)), ((x$27i179) !== false ? (((x$27i179 === $sym("null")) === false) ? (($B["equal?"](x$27i179, 0) === false) ? ($B["equal?"](x$27i179, "") === false) : false) : false) : false)) === false)) : false));
        return show_queue$27276(q$27308);
      } else {
        return false;
      }
    });
    (show_queue$27276 = function (q) {
      let at$27313, each$27315, items$27312, list$27311, shape$27314;
      (list$27311 = by_id$27dom("remote-queue"));
      if ((list$27311) !== false) {
        if (((listing$27265 ? q : false) === false)) {
          set_hidden$21$27dom(list$27311, true);
          return (listed$27266 = "");
        } else {
          (items$27312 = $B["map-ref"](q, "items", $B["vector"]()));
          (at$27313 = $B["map-ref"](q, "at", 0));
          (shape$27314 = queue_shape$27277(items$27312, at$27313));
          set_hidden$21$27dom(list$27311, false);
          if ($B["equal?"](shape$27314, listed$27266)) {
            return false;
          } else {
            (listed$27266 = shape$27314);
            clear$21$27dom(list$27311);
            (each$27315 = function (i) {
              for (;;) {
                if ((i < $B["vector-length"](items$27312))) {
                  append$21$27dom(list$27311, queue_row$27278($B["vector-ref"](items$27312, i), (i === at$27313)));
                  const $t0 = (i + 1);
                  i = $t0;
                  continue;
                } else {
                  return false;
                }
              }
            });
            return each$27315(0);
          }
        }
      } else {
        return false;
      }
    });
    (queue_shape$27277 = function (items, at) {
      let each$27316;
      (each$27316 = function (i, out) {
        let x$27i180;
        for (;;) {
          if ((i < $B["vector-length"](items))) {
            const $t0 = (i + 1);
            const $t1 = $B["string-append"](out, ";", $B["number->string"](((x$27i180 = $B["map-ref"]($B["vector-ref"](items, i), "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i180))))));
            i = $t0;
            out = $t1;
            continue;
          } else {
            return out;
          }
        }
      });
      return each$27316(0, $B["number->string"](at));
    });
    (queue_row$27278 = function (item, playing) {
      let artist$27319, b$27318, li$27317, x$27i181, x$27i182, x$27i183;
      (li$27317 = make_element$27dom("li"));
      (b$27318 = make_element$27dom("button"));
      set_attribute$21$27dom(b$27318, "type", "button");
      set_attribute$21$27dom(b$27318, "data-item", $B["number->string"](((x$27i181 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i181))))));
      set_attribute$21$27dom(b$27318, "class", (playing ? "remote-row playing" : "remote-row"));
      set_text$21$27dom(b$27318, ((artist$27319 = ((x$27i182 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i182) ? x$27i182 : ($B["number?"](x$27i182) ? $B["number->string"](x$27i182) : "")))), $B["string-append"](((x$27i183 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i183) ? x$27i183 : ($B["number?"](x$27i183) ? $B["number->string"](x$27i183) : ""))), ($B["equal?"](artist$27319, "") ? "" : $B["string-append"](" \xc2\xb7 ", artist$27319)))));
      append$21$27dom(li$27317, b$27318);
      return li$27317;
    });
    (command$27279 = function (name, value) {
      let msg$27i184, msg$27i185, op$27321, position$27322, q$27320;
      if ($B["equal?"](chosen$27257, "")) {
        return false;
      } else {
        (q$27320 = from_queue$27268(screen_of$27where(chosen$27257)));
        (op$27321 = $B["map-ref"](as_queue$27remote, name, false));
        if ((((q$27320) !== false ? op$27321 : false)) !== false) {
          (position$27322 = $B["map-ref"](q$27320, "position", 0));
          (msg$27i184 = $B["map-of"]("type", "queue", "op", op$27321, "queue", $B["map-ref"](q$27320, "queue", 0), "value", ($B["equal?"](name, "back") ? ((position$27322 > 10) ? (position$27322 - 10) : 0) : ($B["equal?"](name, "forward") ? (position$27322 + 30) : value))));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i184));
          } else {
            return false;
          }
        } else {
          (msg$27i185 = $B["map-of"]("type", "control", "target", chosen$27257, "command", name, "value", value));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i185));
          } else {
            return false;
          }
        }
      }
    });
    (seek_value$27280 = function () {
      let n$27323;
      (n$27323 = $B["string->number"](value_of$27dom(seek$27264)));
      if ((n$27323) !== false) {
        return n$27323;
      } else {
        return 0;
      }
    });
    ((handler$27i186 = function (text, m) {
      (queues$27262 = $B["map-set"](queues$27262, $B["map-ref"](m, "id", 0), $B["map-set"](m, "received", now_ms$27page())));
      return render$27275();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue", $B["append"]($B["map-ref"](handlers$27socket, "queue", null), $listFromEnd(handler$27i186)))));
    ((handler$27i189 = function (text, m) {
      let each$27325, l$27324;
      ((l$27324 = $B["map-ref"](m, "targets", $B["vector"]())), (each$27325 = function (i) {
        let msg$27i188, q$27326, x$27i187;
        for (;;) {
          if ((i < $B["vector-length"](l$27324))) {
            (q$27326 = ((x$27i187 = $B["map-ref"]($B["vector-ref"](l$27324, i), "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i187)))));
            (((q$27326 > 0) ? ($B["map-ref"](queues$27262, q$27326, false) === false) : false) ? ((msg$27i188 = $B["map-of"]("type", "queue", "op", "state", "queue", q$27326)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i188)) : false)) : false);
            const $t0 = (i + 1);
            i = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27325(0));
      return render$27275();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "targets", $B["append"]($B["map-ref"](handlers$27socket, "targets", null), $listFromEnd(handler$27i189)))));
    ((handler$27i190 = function (text, m) {
      return render$27275();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i190)))));
    ((handler$27i191 = function (text, s) {
      (states$27261 = $B["map-set"](states$27261, $B["map-ref"](s, "from", ""), s));
      return render$27275();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "state", $B["append"]($B["map-ref"](handlers$27socket, "state", null), $listFromEnd(handler$27i191)))));
    every$27page(1000, function () {
      if ((from_queue$27268(screen_of$27where(chosen$27257))) !== false) {
        return render$27275();
      } else {
        return false;
      }
    });
    on$27dom(tabs$27263, click$27dom, function (e) {
      let b$27327;
      (b$27327 = closest_of$27dom(e, "[data-screen]"));
      if ((b$27327) !== false) {
        (chosen$27257 = data_of$27dom(b$27327, "screen"));
        (picked$27260 = true);
        return render$27275();
      } else {
        return false;
      }
    });
    on$27dom(remote, click$27dom, function (e) {
      let b$27328;
      (b$27328 = closest_of$27dom(e, "[data-command]"));
      if ((b$27328) !== false) {
        return command$27279(data_of$27dom(b$27328, "command"), 0);
      } else {
        return false;
      }
    });
    ((button$27329 = by_id$27dom("remote-list")), ((button$27329) !== false ? on$27dom(button$27329, click$27dom, function (e) {
      (listing$27265 = (listing$27265 === false));
      set_attribute$21$27dom(button$27329, "aria-expanded", (listing$27265 ? "true" : "false"));
      return render$27275();
    }) : false));
    ((list$27330 = by_id$27dom("remote-queue")), ((list$27330) !== false ? on$27dom(list$27330, click$27dom, function (e) {
      let b$27331, msg$27i192, n$27333, q$27332;
      (b$27331 = closest_of$27dom(e, "[data-item]"));
      (q$27332 = queue_of$27267(screen_of$27where(chosen$27257)));
      if ((((b$27331) !== false ? q$27332 : false)) !== false) {
        (msg$27i192 = $B["map-of"]("type", "queue", "op", "jump", "queue", $B["map-ref"](q$27332, "id", 0), "item", ((n$27333 = $B["string->number"](data_of$27dom(b$27331, "item"))), ((n$27333) !== false ? n$27333 : 0))));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i192));
        } else {
          return false;
        }
      } else {
        return false;
      }
    }) : false));
    on$27dom(seek$27264, input$27dom, function (e) {
      (dragging$27258 = true);
      return text$21$27remote("remote-time", $B["string-append"](clock$27clock(real_of$27said(seek_value$27280())), " / ", clock$27clock(real_of$27said($B["map-ref"]($B["map-ref"](states$27261, chosen$27257, $B["map-of"]()), "duration", 0)))));
    });
    on$27dom(seek$27264, change$27dom, function (e) {
      (dragging$27258 = false);
      return command$27279("seek", seek_value$27280());
    });
    return render$27275();
  });
  (bar_player$27bar = false);
  (bar_key$27bar = "hazelflix-bar");
  (bar_wake$21$27bar = function (queue) {
    let r$27i194, r$27i195, r$27i196;
    if ((bar_player$27bar) !== false) {
      (((((r$27i194 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i194))() ? (((r$27i195 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i195))() === queue) : false)) !== false ? false : ((r$27i196 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i196))(queue));
      return true;
    } else {
      return false;
    }
  });
  (nothing$27bar = function () {
    return false;
  });
  (players_start$27bar = function () {
    let bar$27335, close$27dom$27337, film$27i197, film$27i200, handler$27i208, on_load$27i198, on_load$27i201, on_sleep$27i203, on_wake$27i202, player$27336, screen$27334;
    (screen$27334 = by_id$27dom("player-screen"));
    (bar$27335 = by_id$27dom("music-bar"));
    if ((screen$27334) !== false) {
      return start_player$27player(screen$27334, ((film$27i197 = function (item) {
        return false;
      }), (on_load$27i198 = function (item, p) {
        return false;
      }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", false, false, film$27i197, on_load$27i198, nothing$27bar, nothing$27bar)));
    } else {
      if ((bar$27335) !== false) {
        (player$27336 = start_player$27player(bar$27335, ((film$27i200 = function (item) {
          return false;
        }), (on_load$27i201 = function (item, p) {
          return false;
        }), (on_wake$27i202 = function () {
          let r$27i199;
          set_hidden$21$27dom(bar$27335, false);
          add_class$21$27dom(body$27dom(), "with-bar");
          ((bar_player$27bar) !== false ? session_set$21$27page(bar_key$27bar, $B["number->string"](((r$27i199 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i199))())) : false);
          return false;
        }), (on_sleep$27i203 = function () {
          set_hidden$21$27dom(bar$27335, true);
          remove_class$21$27dom(body$27dom(), "with-bar");
          session_remove$21$27page(bar_key$27bar);
          return false;
        }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", true, true, film$27i200, on_load$27i201, on_wake$27i202, on_sleep$27i203))));
        (bar_player$27bar = player$27336);
        ((close$27dom$27337 = query_in$27dom(bar$27335, "[data-bar-close]")), ((close$27dom$27337) !== false ? on$27dom(close$27dom$27337, click$27dom, function (e) {
          let r$27i204;
          return ((r$27i204 = player$27336), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r$27i204))();
        }) : false));
        (handler$27i208 = function (text, m) {
          let r$27i206, r$27i207, was$27338, x$27i205;
          (was$27338 = ((x$27i205 = $B["string->number"](session_get$27page(bar_key$27bar))), $B["exact"]($B["floor"](real_of$27said(x$27i205)))));
          if ((((was$27338 > 0) ? (((r$27i206 = player$27336), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i206))() === false) : false)) !== false) {
            return ((r$27i207 = player$27336), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i207))(was$27338);
          } else {
            return false;
          }
        });
        return (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i208))));
      } else {
        return false;
      }
    }
  });
  (digits$3f$27bar = function (s, from) {
    let loop$27339;
    if ((from < $B["string-length"](s))) {
      (loop$27339 = function (i) {
        let b$27340;
        for (;;) {
          if ((i === $B["string-length"](s))) {
            return true;
          } else {
            if (((b$27340 = $B["byte-ref"](s, i)), ((b$27340 >= 48) ? (b$27340 <= 57) : false))) {
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return false;
            }
          }
        }
      });
      return loop$27339(from);
    } else {
      return false;
    }
  });
  (site_path$27bar = function (url) {
    let cut$27342, origin$27page$27341;
    (origin$27page$27341 = origin$27page());
    if (($B["string-prefix?"](origin$27page$27341, url) ? $B["string-prefix?"]("/", $B["substring"](url, $B["string-length"](origin$27page$27341), $B["string-length"](url))) : false)) {
      (cut$27342 = function (p, i) {
        let or$27value$27343;
        for (;;) {
          if ((i === $B["string-length"](p))) {
            if (((i > 1) ? $B["string-suffix?"]("/", p) : false)) {
              return $B["substring"](p, 0, (i - 1));
            } else {
              return p;
            }
          } else {
            if (((or$27value$27343 = ($B["byte-ref"](p, i) === 63)), (or$27value$27343 ? or$27value$27343 : ($B["byte-ref"](p, i) === 35)))) {
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
      return cut$27342($B["substring"](url, $B["string-length"](origin$27page$27341), $B["string-length"](url)), 0);
    } else {
      return false;
    }
  });
  (swappable$3f$27bar = function (url) {
    let or$27value$27345, or$27value$27346, or$27value$27347, or$27value$27348, or$27value$27349, or$27value$27350, or$27value$27351, p$27344;
    (p$27344 = site_path$27bar(url));
    if ((p$27344) !== false) {
      (or$27value$27345 = $B["equal?"](p$27344, "/music"));
      if (or$27value$27345) {
        return or$27value$27345;
      } else {
        (or$27value$27346 = $B["equal?"](p$27344, "/music/songs"));
        if (or$27value$27346) {
          return or$27value$27346;
        } else {
          (or$27value$27347 = $B["equal?"](p$27344, "/music/videos"));
          if (or$27value$27347) {
            return or$27value$27347;
          } else {
            (or$27value$27348 = $B["equal?"](p$27344, "/music/artists"));
            if (or$27value$27348) {
              return or$27value$27348;
            } else {
              (or$27value$27349 = $B["equal?"](p$27344, "/music/playlists"));
              if (or$27value$27349) {
                return or$27value$27349;
              } else {
                (or$27value$27350 = ($B["string-prefix?"]("/album/", p$27344) ? digits$3f$27bar(p$27344, 7) : false));
                if ((or$27value$27350) !== false) {
                  return or$27value$27350;
                } else {
                  (or$27value$27351 = ($B["string-prefix?"]("/artist/", p$27344) ? digits$3f$27bar(p$27344, 8) : false));
                  if ((or$27value$27351) !== false) {
                    return or$27value$27351;
                  } else {
                    if ($B["string-prefix?"]("/playlist/", p$27344)) {
                      return digits$3f$27bar(p$27344, 10);
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
    let or$27value$27352, or$27value$27353;
    (or$27value$27352 = $B["equal?"](id_of$27dom(e), "music-bar"));
    if (or$27value$27352) {
      return or$27value$27352;
    } else {
      (or$27value$27353 = $B["equal?"](tag_of$27dom(e), "SCRIPT"));
      if (or$27value$27353) {
        return or$27value$27353;
      } else {
        return $B["equal?"](id_of$27dom(e), "intro");
      }
    }
  });
  (go$27bar = function (url, push) {
    return fetch_text$27fetch(url, function (status, text) {
      let bar$27358, coming$27363, doc$27354, each$27362, each$27364, fresh$27356, fresh_body$27355, here$27357, new_style$27360, now$27361, old_style$27359;
      if ((status === 0)) {
        return go$21$27page(url);
      } else {
        (doc$27354 = read_page$27page(text));
        (fresh_body$27355 = body_of$27dom(doc$27354));
        (fresh$27356 = ((fresh_body$27355) !== false ? first_element_of$27dom(fresh_body$27355) : false));
        (here$27357 = first_element_of$27dom(body$27dom()));
        (bar$27358 = by_id$27dom("music-bar"));
        if ((((fresh$27356) !== false ? ((here$27357) !== false ? ((bar$27358) !== false ? query_in$27dom(doc$27354, "main") : false) : false) : false)) !== false) {
          (old_style$27359 = head_style$27page(this_page$27dom()));
          (new_style$27360 = head_style$27page(doc$27354));
          ((((old_style$27359) !== false ? new_style$27360 : false)) !== false ? set_text$21$27dom(old_style$27359, text_of$27dom(new_style$27360)) : false);
          set_page_title$21$27page(page_title$27page(doc$27354));
          ((now$27361 = children_of$27dom(here$27357)), ((each$27362 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](now$27361))) {
                (kept$3f$27bar($B["vector-ref"](now$27361, i)) ? false : remove$21$27dom($B["vector-ref"](now$27361, i)));
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          }), each$27362(0)));
          ((coming$27363 = children_of$27dom(fresh$27356)), ((each$27364 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](coming$27363))) {
                (kept$3f$27bar($B["vector-ref"](coming$27363, i)) ? false : insert_before$21$27dom(here$27357, import$21$27dom($B["vector-ref"](coming$27363, i)), bar$27358));
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          }), each$27364(0)));
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
        let a$27365, r$27i193$27i209, url$27366;
        if (((((bar_player$27bar) !== false ? ((r$27i193$27i209 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i193$27i209))() : false)) !== false ? ((default_prevented$3f$27dom(e) === false) ? plain_click$3f$27dom(e) : false) : false)) {
          (a$27365 = closest_of$27dom(e, "a[href]"));
          if ((a$27365) !== false) {
            (url$27366 = link_address$27page(a$27365));
            if (((($B["equal?"](url$27366, "") === false) ? swappable$3f$27bar(url$27366) : false)) !== false) {
              prevent_default$21$27dom(e);
              return go$27bar(url$27366, true);
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
        let r$27i193$27i210;
        if ((((((bar_player$27bar) !== false ? ((r$27i193$27i210 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i193$27i210))() : false)) !== false ? swappable$3f$27bar(address$27page()) : false)) !== false) {
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
      let t$27368;
      if ($B["null?"](l)) {
        return null;
      } else {
        (t$27368 = $B["car"](l));
        return $B["cons"]($B["cons"]($B["map-ref"](t$27368, "name", ""), function () {
          return send$27music($B["map-set"](msg, "target", $B["map-ref"](t$27368, "id", "")));
        }), choices($B["cdr"](l)));
      }
    });
    return choose$27ui("Play where?", $B["cons"]($B["cons"]("This browser", function () {
      return send$27music(msg);
    }), choices(there)));
  });
  (music_buttons$27music = function () {
    let handler$27i215, handler$27i216;
    on_document$27dom(click$27dom, function (e) {
      let b$27369, msg$27370, n$27367$27i212, n$27367$27i214, s$27i211, s$27i213, there$27371;
      (b$27369 = closest_of$27dom(e, "[data-music]"));
      if ((b$27369) !== false) {
        (msg$27370 = $B["map-of"]("type", "queue", "op", data_of$27dom(b$27369, "music"), "what", data_of$27dom(b$27369, "what"), "id", ((s$27i211 = data_of$27dom(b$27369, "id")), ((n$27367$27i212 = $B["string->number"](s$27i211)), ((n$27367$27i212) !== false ? n$27367$27i212 : 0))), "start", ((s$27i213 = data_of$27dom(b$27369, "start")), ((n$27367$27i214 = $B["string->number"](s$27i213)), ((n$27367$27i214) !== false ? n$27367$27i214 : 0))), "shuffle", $B["equal?"](data_of$27dom(b$27369, "shuffle"), "1"), "next", $B["equal?"](data_of$27dom(b$27369, "next"), "1"), "queue", queue_now$27player));
        (there$27371 = other_screens$27where());
        prevent_default$21$27dom(e);
        if (($B["equal?"](data_of$27dom(b$27369, "music"), "play") ? (($B["null?"](there$27371) === false) ? (dialogs$3f$27dom() ? (by_id$27dom("player-screen") === false) : false) : false) : false)) {
          return ask_where$27music(msg$27370, there$27371);
        } else {
          return send$27music(msg$27370);
        }
      } else {
        return false;
      }
    });
    ((handler$27i215 = function (text, m) {
      let name$27372;
      if ((by_id$27dom("player-screen")) !== false) {
        return false;
      } else {
        if (($B["map-ref"](m, "elsewhere", false)) !== false) {
          return note$27ui(((name$27372 = $B["map-ref"](m, "name", "")), ($B["equal?"](name$27372, "") ? "Playing on the player that's open." : $B["string-append"]("Playing on ", name$27372, "."))));
        } else {
          if (bar_wake$21$27bar($B["map-ref"](m, "queue", 0))) {
            return false;
          } else {
            return go$21$27page($B["string-append"]("/music/player?queue=", $B["number->string"]($B["map-ref"](m, "queue", 0))));
          }
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queued", $B["append"]($B["map-ref"](handlers$27socket, "queued", null), $listFromEnd(handler$27i215)))));
    (handler$27i216 = function (text, m) {
      let n$27373;
      (n$27373 = $B["map-ref"](m, "n", 1));
      return note$27ui(((n$27373 === 1) ? "Added to the queue." : $B["string-append"]($B["number->string"](n$27373), " added to the queue.")));
    });
    return (handlers$27socket = $B["map-set"](handlers$27socket, "added", $B["append"]($B["map-ref"](handlers$27socket, "added", null), $listFromEnd(handler$27i216))));
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
    let chooser$27377, finished$27385, going$27380, handler$27i230, line_for$27382, lines$27378, made$27381, next$27384, queue$27379, send_file$27386, sending$3f$27383, watch$27387;
    (chooser$27377 = by_id$27dom("photo-files"));
    (lines$27378 = by_id$27dom("photo-uploads"));
    (queue$27379 = null);
    (going$27380 = 0);
    (made$27381 = 0);
    (line_for$27382 = function (name) {
      let l$27388;
      (l$27388 = make_element$27dom("div"));
      set_text$21$27dom(l$27388, $B["string-append"](name, ": waiting"));
      append$21$27dom(lines$27378, l$27388);
      return l$27388;
    });
    (sending$3f$27383 = function () {
      let or$27value$27389;
      (or$27value$27389 = (going$27380 > 0));
      if (or$27value$27389) {
        return or$27value$27389;
      } else {
        return $B["pair?"](queue$27379);
      }
    });
    (next$27384 = function () {
      let f$27390;
      for (;;) {
        if (((going$27380 < at_once$27photos) ? $B["pair?"](queue$27379) : false)) {
          (f$27390 = $B["car"](queue$27379));
          (queue$27379 = $theList($B["cdr"](queue$27379)));
          (going$27380 = (going$27380 + 1));
          send_file$27386(f$27390);
          continue;
        } else {
          return false;
        }
      }
    });
    (finished$27385 = function () {
      (going$27380 = (going$27380 - 1));
      return next$27384();
    });
    (send_file$27386 = function (f) {
      let began$27395, failed$27396, from$27397, id$27393, line$27394, name$27391, size$27392;
      (name$27391 = file_name$27fetch(f));
      (size$27392 = file_size$27fetch(f));
      (id$27393 = $B["random-hex"](16));
      (line$27394 = line_for$27382(name$27391));
      (began$27395 = now_ms$27page());
      (failed$27396 = function (why) {
        set_text$21$27dom(line$27394, $B["string-append"](name$27391, ": ", why));
        set_style$21$27dom(line$27394, "color", "#f0b446");
        return finished$27385();
      });
      (from$27397 = function (at, tried) {
        let asked$27399, end$27398, id$27i217, most$27400, name$27i218, size$27i219;
        (end$27398 = (((at + piece$27photos) > size$27392) ? size$27392 : (at + piece$27photos)));
        (asked$27399 = now_ms$27page());
        (most$27400 = 0);
        return post_piece_watched$21$27fetch(((id$27i217 = id$27393), (name$27i218 = name$27391), (size$27i219 = size$27392), $B["string-append"]("/photos/upload?id=", id$27i217, "&name=", encode_component$27page(name$27i218), "&size=", $B["number->string"](size$27i219))), f, at, end$27398, quiet_ms$27photos, function (sent) {
          let bytes$27i220, mb$27376$27i222, ms$27i221;
          ((sent > most$27400) ? (most$27400 = sent) : false);
          return set_text$21$27dom(line$27394, $B["string-append"](name$27391, ": ", $B["number->string"]($B["quotient"]((100 * (at + sent)), size$27392)), "%", ((bytes$27i220 = (at + sent)), (ms$27i221 = (now_ms$27page() - began$27395)), ((ms$27i221 < 500.0) ? "" : ((mb$27376$27i222 = (((bytes$27i220 + 0.0) / 1048576.0) / (ms$27i221 / 1000.0))), $B["string-append"](", ", $realText(($B["round"]((mb$27376$27i222 * 10.0)) / 10.0)), " MB/s"))))));
        }, function (status, body$27dom) {
          let bytes$27i227, m$27374$27i223, m$27374$27i225, mb$27376$27i229, ms$27i228, v$27375$27i224, v$27375$27i226, why$27401;
          post_form$21$27fetch("/photos/log", $B["string-append"]("line=", encode_component$27page($B["string-append"]("page ", $B["substring"](id$27393, 0, 6), " at ", $B["number->string"](at), "-", $B["number->string"](end$27398), " try ", $B["number->string"](tried), ": status ", $B["number->string"](status), " after ", $B["number->string"]($B["exact"]($B["round"]((now_ms$27page() - asked$27399)))), " ms, ", $B["number->string"](most$27400), " bytes seen going, ", (($B["string-length"](body$27dom) > 60) ? $B["substring"](body$27dom, 0, 60) : body$27dom)))));
          if ((((status <= 0) ? (tried < tries$27photos) : false)) !== false) {
            set_text$21$27dom(line$27394, $B["string-append"](name$27391, ": ", ((status === -1) ? $B["string-append"]("the phone wouldn't hand it over (", body$27dom, "), trying again") : "stalled, trying again")));
            return after$27page(2000, function () {
              return from$27397(at, (tried + 1));
            });
          } else {
            if ((status === -1)) {
              return failed$27396($B["string-append"]("the phone wouldn't hand it over (", body$27dom, ")"));
            } else {
              if (((status === 200) === false)) {
                return failed$27396(((why$27401 = ((m$27374$27i223 = $B["json-parse"](body$27dom, false)), ($B["map?"](m$27374$27i223) ? ((v$27375$27i224 = $B["map-ref"](m$27374$27i223, "error", "")), ($B["string?"](v$27375$27i224) ? v$27375$27i224 : "")) : ""))), ($B["equal?"](why$27401, "") ? "couldn't be sent" : why$27401)));
              } else {
                if ((end$27398 < size$27392)) {
                  return from$27397(end$27398, 1);
                } else {
                  if ($B["equal?"](((m$27374$27i225 = $B["json-parse"](body$27dom, false)), ($B["map?"](m$27374$27i225) ? ((v$27375$27i226 = $B["map-ref"](m$27374$27i225, "state", "")), ($B["string?"](v$27375$27i226) ? v$27375$27i226 : "")) : "")), "known")) {
                    set_text$21$27dom(line$27394, $B["string-append"](name$27391, ": already here"));
                    return finished$27385();
                  } else {
                    (made$27381 = (made$27381 + 1));
                    set_text$21$27dom(line$27394, $B["string-append"](name$27391, ": sent", ((bytes$27i227 = size$27392), (ms$27i228 = (now_ms$27page() - began$27395)), ((ms$27i228 < 500.0) ? "" : ((mb$27376$27i229 = (((bytes$27i227 + 0.0) / 1048576.0) / (ms$27i228 / 1000.0))), $B["string-append"](", ", $realText(($B["round"]((mb$27376$27i229 * 10.0)) / 10.0)), " MB/s")))), ", being made ready"));
                    return finished$27385();
                  }
                }
              }
            }
          }
        });
      });
      if ((size$27392 === 0)) {
        return failed$27396("empty");
      } else {
        if ((size$27392 > piece$27photos)) {
          return failed$27396("too large: 64 MB at most");
        } else {
          return from$27397(0, 1);
        }
      }
    });
    if ((chooser$27377 === false)) {
      return false;
    } else {
      (watch$27387 = function (input$27dom) {
        return on$27dom(input$27dom, change$27dom, function (e) {
          (queue$27379 = $B["append"](queue$27379, $B["vector->list"](chosen_files$27fetch(input$27dom))));
          watch$27387(file_input_again$21$27fetch(input$27dom));
          return next$27384();
        });
      });
      watch$27387(chooser$27377);
      ((handler$27i230 = function (text, msg) {
        let or$27value$27402;
        if (((((or$27value$27402 = (made$27381 > 0)), (or$27value$27402 ? or$27value$27402 : query$27dom("[data-photos-making]")))) !== false ? (sending$3f$27383() === false) : false)) {
          return reload$21$27page();
        } else {
          return false;
        }
      }), (handlers$27socket = $B["map-set"](handlers$27socket, "photos", $B["append"]($B["map-ref"](handlers$27socket, "photos", null), $listFromEnd(handler$27i230)))));
      return photo_dialog$27photos();
    }
  });
  (place_pin$27photos = function (place) {
    let pin$27403;
    (pin$27403 = by_id$27dom("photo-dialog-place"));
    if ((pin$27403) !== false) {
      set_attribute$21$27dom(pin$27403, "data-place", place);
      return set_hidden$21$27dom(pin$27403, $B["equal?"](place, ""));
    } else {
      return false;
    }
  });
  (photo_dialog$27photos = function () {
    let cancel$27407, d$27404, delete$27408, pin$27406;
    (d$27404 = by_id$27dom("photo-dialog"));
    if (((d$27404) !== false ? dialogs$3f$27dom() : false)) {
      each_of$27photos($B["vector->list"](query_all$27dom("[data-photo]")), function (card) {
        return on$27dom(card, click$27dom, function (e) {
          let id$27405;
          if (plain_click$3f$27dom(e)) {
            (id$27405 = data_of$27dom(card, "photo"));
            prevent_default$21$27dom(e);
            set_attribute$21$27dom(by_id$27dom("photo-dialog-img"), "src", $B["string-append"]("/photo/", id$27405));
            set_text$21$27dom(by_id$27dom("photo-dialog-date"), data_of$27dom(card, "date"));
            set_field$21$27dom(by_id$27dom("photo-dialog-caption"), data_of$27dom(card, "caption"));
            place_pin$27photos(data_of$27dom(card, "place"));
            set_attribute$21$27dom(by_id$27dom("photo-dialog-form"), "action", $B["string-append"]("/photos/", id$27405));
            return show_modal$21$27dom(d$27404);
          } else {
            return false;
          }
        });
      });
      ((pin$27406 = by_id$27dom("photo-dialog-place")), ((pin$27406) !== false ? (place_pin$27photos(data_of$27dom(pin$27406, "place")), on$27dom(pin$27406, click$27dom, function (e) {
        set_field$21$27dom(by_id$27dom("photo-dialog-caption"), data_of$27dom(pin$27406, "place"));
        return focus$21$27dom(by_id$27dom("photo-dialog-caption"));
      })) : false));
      ((cancel$27407 = query$27dom("[data-photo-cancel]")), (delete$27408 = query$27dom("[data-photo-delete]")), ((cancel$27407) !== false ? on$27dom(cancel$27407, click$27dom, function (e) {
        prevent_default$21$27dom(e);
        return close_dialog$21$27dom(d$27404);
      }) : false), ((delete$27408) !== false ? on$27dom(delete$27408, click$27dom, function (e) {
        if (confirmed$3f$27page("Delete this photo? Its original goes too.")) {
          return false;
        } else {
          return prevent_default$21$27dom(e);
        }
      }) : false));
      return on$27dom(d$27404, click$27dom, function (e) {
        if ((closest_of$27dom(e, "#photo-dialog img, #photo-dialog form")) !== false) {
          return false;
        } else {
          return close_dialog$21$27dom(d$27404);
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
      return $theList($B["cdr"](l));
    } else {
      return $B["cons"]($B["car"](l), without$27saver($theList($B["cdr"](l)), (i - 1)));
    }
  });
  (saver_runs$27saver = function () {
    let saver$27409, wait$27410;
    (saver$27409 = by_id$27dom("saver"));
    (wait$27410 = by_id$27dom("ready-wait"));
    if ((((saver$27409) !== false ? wait$27410 : false)) !== false) {
      return saver_shows$27saver(saver$27409, wait$27410);
    } else {
      return false;
    }
  });
  (saver_shows$27saver = function (saver, wait) {
    let end$27420, front$27413, handler$27i237, handler$27i238, load_photos$27421, next_photo$27416, order$27412, photos$27411, show$27418, showing$27415, start$27419, texts$27417, timer$27414;
    (photos$27411 = $B["vector"]());
    (order$27412 = null);
    (front$27413 = false);
    (timer$27414 = 0);
    (showing$27415 = false);
    (next_photo$27416 = function () {
      let i$27422, p$27423;
      ($B["null?"](order$27412) ? (order$27412 = $B["vector->list"](photos$27411)) : false);
      (i$27422 = $B["exact"]($B["floor"]((random$27page() * $B["length"](order$27412)))));
      (p$27423 = nth$27saver(order$27412, i$27422));
      (order$27412 = without$27saver(order$27412, i$27422));
      return p$27423;
    });
    (texts$27417 = function (p) {
      set_text$21$27dom(by_id$27dom("saver-caption"), $B["map-ref"](p, "caption", ""));
      return set_text$21$27dom(by_id$27dom("saver-date"), $B["map-ref"](p, "date", ""));
    });
    (show$27418 = function (p) {
      let back$27427, begin_moving$27432, coming$27424, from$27430, going$27425, img$27426, scale$27i231, scale$27i234, to$27431, url$27428, x$27i232, x$27i235, y$27i233, y$27i236, zoom_in$27429;
      (coming$27424 = by_id$27dom(($B["equal?"](front$27413, "saver-a") ? "saver-b" : "saver-a")));
      (going$27425 = ((front$27413) !== false ? by_id$27dom(front$27413) : false));
      (img$27426 = query_in$27dom(coming$27424, "img"));
      (back$27427 = query_in$27dom(coming$27424, ".saver-back"));
      (url$27428 = $B["string-append"]("/photo/", $B["number->string"]($B["map-ref"](p, "id", 0))));
      (zoom_in$27429 = (random$27page() < 0.5));
      (from$27430 = ((scale$27i231 = (zoom_in$27429 ? 1.0 : 1.1000000000000001)), (x$27i232 = (-2.0 + ((2.0 - -2.0) * random$27page()))), (y$27i233 = (-2.0 + ((2.0 - -2.0) * random$27page()))), $B["string-append"]("scale(", $realText(scale$27i231), ") translate(", $B["string-append"]($realText(($B["round"]((x$27i232 * 100.0)) / 100.0)), "%"), ", ", $B["string-append"]($realText(($B["round"]((y$27i233 * 100.0)) / 100.0)), "%"), ")")));
      (to$27431 = ((scale$27i234 = (zoom_in$27429 ? 1.1000000000000001 : 1.0)), (x$27i235 = (-2.0 + ((2.0 - -2.0) * random$27page()))), (y$27i236 = (-2.0 + ((2.0 - -2.0) * random$27page()))), $B["string-append"]("scale(", $realText(scale$27i234), ") translate(", $B["string-append"]($realText(($B["round"]((x$27i235 * 100.0)) / 100.0)), "%"), ", ", $B["string-append"]($realText(($B["round"]((y$27i236 * 100.0)) / 100.0)), "%"), ")")));
      (begin_moving$27432 = function () {
        set_style$21$27dom(coming$27424, "transition", "none");
        set_style$21$27dom(coming$27424, "transform", from$27430);
        set_style$21$27dom(coming$27424, "opacity", "0");
        after$27page(50, function () {
          set_style$21$27dom(coming$27424, "transition", "transform 11.5s linear, opacity 1.5s ease");
          set_style$21$27dom(coming$27424, "transform", to$27431);
          set_style$21$27dom(coming$27424, "opacity", "1");
          texts$27417(p);
          if ((going$27425) !== false) {
            return set_style$21$27dom(going$27425, "opacity", "0");
          } else {
            return false;
          }
        });
        (front$27413 = id_of$27dom(coming$27424));
        return (timer$27414 = after$27page(shown_ms$27saver, function () {
          if (showing$27415) {
            return show$27418(next_photo$27416());
          } else {
            return false;
          }
        }));
      });
      on_once$27dom(img$27426, load$27dom, function (e) {
        if (showing$27415) {
          return begin_moving$27432();
        } else {
          return false;
        }
      });
      set_style$21$27dom(back$27427, "background-image", $B["string-append"]("url(", url$27428, ")"));
      return set_attribute$21$27dom(img$27426, "src", url$27428);
    });
    (start$27419 = function () {
      (showing$27415 = true);
      set_text$21$27dom(by_id$27dom("saver-name"), $B["map-ref"](self$27socket, "name", ""));
      set_hidden$21$27dom(saver, false);
      return show$27418(next_photo$27416());
    });
    (end$27420 = function () {
      (showing$27415 = false);
      cancel_timer$21$27page(timer$27414);
      return set_hidden$21$27dom(saver, true);
    });
    (load_photos$27421 = function () {
      return fetch_text$27fetch("/photos.json", function (status, body$27dom) {
        let l$27433;
        (l$27433 = ((status === 200) ? $B["json-parse"](body$27dom, false) : false));
        if ($B["vector?"](l$27433)) {
          (photos$27411 = $theVector(l$27433));
          (order$27412 = null);
          if ((showing$27415 ? ($B["vector-length"](l$27433) === 0) : false)) {
            return end$27420();
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
    });
    load_photos$27421();
    ((handler$27i237 = function (text, m) {
      return load_photos$27421();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "photos", $B["append"]($B["map-ref"](handlers$27socket, "photos", null), $listFromEnd(handler$27i237)))));
    ((handler$27i238 = function (text, m) {
      return set_text$21$27dom(by_id$27dom("saver-name"), $B["map-ref"](self$27socket, "name", ""));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i238)))));
    return every$27page(1000, function () {
      let want$27434;
      (want$27434 = ((hidden$3f$27dom(wait) === false) ? ($B["vector-length"](photos$27411) > 0) : false));
      if ((want$27434 ? (showing$27415 === false) : false)) {
        return start$27419();
      } else {
        if ((showing$27415 ? (want$27434 === false) : false)) {
          return end$27420();
        } else {
          return false;
        }
      }
    });
  });
  (full$3f$27keypad = function (field, pad) {
    let n$27435;
    (n$27435 = $B["string->number"](data_of$27dom(pad, "length")));
    if ((n$27435) !== false) {
      if ((n$27435 > 0)) {
        return ($B["string-length"](value_of$27dom(field)) >= n$27435);
      } else {
        return false;
      }
    } else {
      return false;
    }
  });
  (keypads_work$27keypad = function () {
    let field$27437, pad$27436;
    (pad$27436 = query$27dom("[data-keypad]"));
    (field$27437 = query$27dom("input[data-code]"));
    if ((((pad$27436) !== false ? field$27437 : false)) !== false) {
      on_document$27dom(click$27dom, function (e) {
        let k$27439, key$27438, now$27440;
        (key$27438 = closest_of$27dom(e, "[data-key]"));
        if ((key$27438) !== false) {
          (k$27439 = data_of$27dom(key$27438, "key"));
          (now$27440 = value_of$27dom(field$27437));
          prevent_default$21$27dom(e);
          ($B["equal?"](k$27439, "back") ? set_field$21$27dom(field$27437, (($B["string-length"](now$27440) > 0) ? $B["substring"](now$27440, 0, ($B["string-length"](now$27440) - 1)) : "")) : (($B["string-length"](now$27440) < 12) ? set_field$21$27dom(field$27437, $B["string-append"](now$27440, k$27439)) : false));
          if (full$3f$27keypad(field$27437, pad$27436)) {
            return submit_form$21$27dom(field$27437);
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
      return on$27dom(field$27437, input$27dom, function (e) {
        if (full$3f$27keypad(field$27437, pad$27436)) {
          return submit_form$21$27dom(field$27437);
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
    let loop$27441;
    (loop$27441 = function (i) {
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
    return loop$27441(0);
  });
  (time_text$27picker = function (t) {
    let hours$27443, minutes$27444, n$27i239, n$27i240, n$27i241, s$27442, seconds$27445;
    const $c1 = $B["floor"](t);
    if (!Number.isInteger($c1)) throw $notInteger;
    (s$27442 = $c1);
    (hours$27443 = $B["quotient"](s$27442, 3600));
    (minutes$27444 = $B["quotient"]($B["remainder"](s$27442, 3600), 60));
    (seconds$27445 = $B["remainder"](s$27442, 60));
    if ((hours$27443 > 0)) {
      return $B["string-append"]($B["number->string"](hours$27443), ":", ((n$27i239 = minutes$27444), ((n$27i239 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i239)) : $B["number->string"](n$27i239))), ":", ((n$27i240 = seconds$27445), ((n$27i240 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i240)) : $B["number->string"](n$27i240))));
    } else {
      return $B["string-append"]($B["number->string"](minutes$27444), ":", ((n$27i241 = seconds$27445), ((n$27i241 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i241)) : $B["number->string"](n$27i241))));
    }
  });
  (number_of$27picker = function (text, fallback) {
    let n$27446;
    (n$27446 = $B["string->number"](text));
    if ((n$27446) !== false) {
      return $theReal((n$27446 + 0.0));
    } else {
      return fallback;
    }
  });
  (pickers_work$27picker = function () {
    return each_in$27picker(query_all$27dom("[data-picker]"), picker_work$27picker);
  });
  (picker_work$27picker = function (p) {
    let box$27448, form$27450, frame$27451, handle$27449, stage$27447;
    (stage$27447 = query_in$27dom(p, "[data-p-stage]"));
    (box$27448 = query_in$27dom(p, "[data-p-box]"));
    (handle$27449 = query_in$27dom(p, "[data-p-handle]"));
    (form$27450 = query_in$27dom(p, "[data-p-form]"));
    (frame$27451 = ((query_in$27dom(p, "video")) !== false ? query_in$27dom(p, "video") : query_in$27dom(p, "img[data-p-frame]")));
    if ((((stage$27447) !== false ? ((box$27448) !== false ? ((handle$27449) !== false ? ((frame$27451) !== false ? form$27450 : false) : false) : false) : false)) !== false) {
      return picker_runs$27picker(p, stage$27447, box$27448, handle$27449, frame$27451, form$27450);
    } else {
      return false;
    }
  });
  (picker_runs$27picker = function (p, stage, box, handle, frame, form) {
    let aspect$27465, choose$27480, dragging$27466, draw$27476, duration$27460, fh$27464, file$27459, fit$27477, frame_h$27474, frame_w$27473, from_x$27467, from_y$27468, fw$27463, fx$27461, fy$27462, go_to$27479, has_video$27456, height_for$27475, label$27453, now$27472, picture$27458, play_button$27455, scrub$27452, set_button$27454, show_time$27478, start_w$27471, start_x$27469, start_y$27470, video$27457;
    (scrub$27452 = query_in$27dom(p, "[data-p-scrub]"));
    (label$27453 = query_in$27dom(p, "[data-p-time]"));
    (set_button$27454 = query_in$27dom(p, "[data-p-set]"));
    (play_button$27455 = query_in$27dom(p, "[data-p-play]"));
    (has_video$27456 = ((query_in$27dom(p, "video")) !== false ? true : false));
    (video$27457 = (has_video$27456 ? media_in$27media(p, "video") : false));
    (picture$27458 = query_in$27dom(p, "img[data-p-frame]"));
    (file$27459 = data_of$27dom(p, "file"));
    (duration$27460 = number_of$27picker(data_of$27dom(p, "duration"), 0.0));
    (fx$27461 = 0.0);
    (fy$27462 = 0.0);
    (fw$27463 = 1.0);
    (fh$27464 = 1.0);
    (aspect$27465 = 0.66666666666666663);
    (dragging$27466 = "");
    (from_x$27467 = 0.0);
    (from_y$27468 = 0.0);
    (start_x$27469 = 0.0);
    (start_y$27470 = 0.0);
    (start_w$27471 = 0.0);
    (now$27472 = number_of$27picker(((scrub$27452) !== false ? value_of$27dom(scrub$27452) : "0"), 0.0));
    (frame_w$27473 = function () {
      return $theReal($B["vector-ref"](rect_of$27dom(frame), 2));
    });
    (frame_h$27474 = function () {
      return $theReal($B["vector-ref"](rect_of$27dom(frame), 3));
    });
    (height_for$27475 = function (w) {
      let H$27482, W$27481, or$27value$27483;
      (W$27481 = frame_w$27473());
      (H$27482 = frame_h$27474());
      if (((or$27value$27483 = (W$27481 <= 0.0)), (or$27value$27483 ? or$27value$27483 : (H$27482 <= 0.0)))) {
        return w;
      } else {
        return ((w * W$27481) / (aspect$27465 * H$27482));
      }
    });
    (draw$27476 = function () {
      let H$27485, W$27484;
      (W$27484 = frame_w$27473());
      (H$27485 = frame_h$27474());
      if (((W$27484 > 0.0) ? (H$27485 > 0.0) : false)) {
        set_style$21$27dom(box, "left", $B["string-append"]($realText((fx$27461 * W$27484)), "px"));
        set_style$21$27dom(box, "top", $B["string-append"]($realText((fy$27462 * H$27485)), "px"));
        set_style$21$27dom(box, "width", $B["string-append"]($realText((fw$27463 * W$27484)), "px"));
        set_style$21$27dom(box, "height", $B["string-append"]($realText((fh$27464 * H$27485)), "px"));
        return set_hidden$21$27dom(box, false);
      } else {
        return false;
      }
    });
    (fit$27477 = function () {
      let h1$27487, h2$27489, w1$27486, w2$27488;
      (w1$27486 = 0.90000000000000002);
      (h1$27487 = height_for$27475(w1$27486));
      (w2$27488 = ((h1$27487 > 0.90000000000000002) ? (w1$27486 * (0.90000000000000002 / h1$27487)) : w1$27486));
      (h2$27489 = height_for$27475(w2$27488));
      (fw$27463 = w2$27488);
      (fh$27464 = h2$27489);
      (fx$27461 = ((1.0 - w2$27488) / 2.0));
      (fy$27462 = ((1.0 - h2$27489) / 2.0));
      return draw$27476();
    });
    (show_time$27478 = function (t) {
      (now$27472 = t);
      ((scrub$27452) !== false ? set_field$21$27dom(scrub$27452, $realText(t)) : false);
      if ((label$27453) !== false) {
        return set_text$21$27dom(label$27453, time_text$27picker(t));
      } else {
        return false;
      }
    });
    (go_to$27479 = function (t) {
      let hi$27i242, t2$27490;
      (t2$27490 = ((hi$27i242 = ((duration$27460 > 0.0) ? duration$27460 : t)), ((t < 0.0) ? 0.0 : ((t > hi$27i242) ? hi$27i242 : t))));
      show_time$27478(t2$27490);
      if (has_video$27456) {
        return seek$21$27media(video$27457, t2$27490);
      } else {
        if ((picture$27458) !== false) {
          return set_attribute$21$27dom(picture$27458, "src", $B["string-append"]("/edit/", file$27459, "/frame?t=", $realText(t2$27490)));
        } else {
          return false;
        }
      }
    });
    (choose$27480 = function (radio) {
      (aspect$27465 = number_of$27picker(data_of$27dom(radio, "aspect"), 0.66666666666666663));
      ((set_button$27454) !== false ? set_text$21$27dom(set_button$27454, $B["string-append"]("Set ", data_of$27dom(radio, "label"))) : false);
      return fit$27477();
    });
    each_in$27picker(query_all_in$27dom(p, "input[name=\"which\"]"), function (radio) {
      (checked$3f$27dom(radio) ? choose$27480(radio) : false);
      return on$27dom(radio, change$27dom, function (e) {
        return choose$27480(radio);
      });
    });
    on$27dom(frame, (has_video$27456 ? loadedmetadata$27media : load$27dom), function (e) {
      return fit$27477();
    });
    on_window$27page(resize$27page, function (e) {
      return draw$27476();
    });
    on$27dom(box, pointerdown$27dom, function (e) {
      prevent_default$21$27dom(e);
      capture_pointer$21$27dom(box, e);
      (dragging$27466 = ((closest_of$27dom(e, "[data-p-handle]")) !== false ? "size" : "move"));
      (from_x$27467 = pointer_x$27dom(e));
      (from_y$27468 = pointer_y$27dom(e));
      (start_x$27469 = fx$27461);
      (start_y$27470 = fy$27462);
      return (start_w$27471 = fw$27463);
    });
    on_document$27dom(pointermove$27dom, function (e) {
      let dx$27491, dy$27492, hh$27495, hi$27i244, hi$27i246, hi$27i248, most_w$27493, w$27494, w2$27496, x$27i243, x$27i245, x$27i247;
      if ($B["equal?"](dragging$27466, "")) {
        return false;
      } else {
        (dx$27491 = ((pointer_x$27dom(e) - from_x$27467) / frame_w$27473()));
        (dy$27492 = ((pointer_y$27dom(e) - from_y$27468) / frame_h$27474()));
        ($B["equal?"](dragging$27466, "move") ? ((fx$27461 = ((x$27i243 = (start_x$27469 + dx$27491)), (hi$27i244 = (1.0 - fw$27463)), ((x$27i243 < 0.0) ? 0.0 : ((x$27i243 > hi$27i244) ? hi$27i244 : x$27i243)))), (fy$27462 = ((x$27i245 = (start_y$27470 + dy$27492)), (hi$27i246 = (1.0 - fh$27464)), ((x$27i245 < 0.0) ? 0.0 : ((x$27i245 > hi$27i246) ? hi$27i246 : x$27i245))))) : ((most_w$27493 = (1.0 - fx$27461)), (w$27494 = ((x$27i247 = (start_w$27471 + dx$27491)), (hi$27i248 = most_w$27493), ((x$27i247 < 0.050000000000000003) ? 0.050000000000000003 : ((x$27i247 > hi$27i248) ? hi$27i248 : x$27i247)))), (hh$27495 = height_for$27475(w$27494)), (w2$27496 = (((fy$27462 + hh$27495) > 1.0) ? (w$27494 * ((1.0 - fy$27462) / hh$27495)) : w$27494)), (fw$27463 = w2$27496), (fh$27464 = height_for$27475(w2$27496))));
        return draw$27476();
      }
    });
    on_document$27dom(pointerup$27dom, function (e) {
      return (dragging$27466 = "");
    });
    ((scrub$27452) !== false ? on$27dom(scrub$27452, input$27dom, function (e) {
      if (has_video$27456) {
        return go_to$27479(number_of$27picker(value_of$27dom(scrub$27452), now$27472));
      } else {
        return show_time$27478(number_of$27picker(value_of$27dom(scrub$27452), now$27472));
      }
    }) : false);
    (((scrub$27452) !== false ? (has_video$27456 === false) : false) ? on$27dom(scrub$27452, change$27dom, function (e) {
      return go_to$27479(number_of$27picker(value_of$27dom(scrub$27452), now$27472));
    }) : false);
    each_in$27picker(query_all_in$27dom(p, "[data-p-step]"), function (b) {
      return on$27dom(b, click$27dom, function (e) {
        (has_video$27456 ? pause$21$27media(video$27457) : false);
        ((play_button$27455) !== false ? set_text$21$27dom(play_button$27455, "Play") : false);
        return go_to$27479(((has_video$27456 ? media_time$27media(video$27457) : now$27472) + (frame_step$27picker * number_of$27picker(data_of$27dom(b, "p-step"), 1.0))));
      });
    });
    (((has_video$27456 ? play_button$27455 : false)) !== false ? (on$27dom(play_button$27455, click$27dom, function (e) {
      if (media_paused$3f$27media(video$27457)) {
        play$21$27media(video$27457);
        return set_text$21$27dom(play_button$27455, "Pause");
      } else {
        pause$21$27media(video$27457);
        return set_text$21$27dom(play_button$27455, "Play");
      }
    }), on$27dom(video$27457, timeupdate$27media, function (e) {
      return show_time$27478(media_time$27media(video$27457));
    }), on$27dom(video$27457, loadedmetadata$27media, function (e) {
      return seek$21$27media(video$27457, now$27472);
    })) : false);
    on$27dom(form, submit$27dom, function (e) {
      let t$27497;
      (t$27497 = (has_video$27456 ? media_time$27media(video$27457) : now$27472));
      set_field$21$27dom(query_in$27dom(form, "input[name=\"t\"]"), $realText(t$27497));
      set_field$21$27dom(query_in$27dom(form, "input[name=\"x\"]"), $realText(fx$27461));
      set_field$21$27dom(query_in$27dom(form, "input[name=\"y\"]"), $realText(fy$27462));
      set_field$21$27dom(query_in$27dom(form, "input[name=\"w\"]"), $realText(fw$27463));
      return set_field$21$27dom(query_in$27dom(form, "input[name=\"h\"]"), $realText(fh$27464));
    });
    if ((frame_w$27473() > 0.0)) {
      return fit$27477();
    } else {
      return false;
    }
  });
  (series_views$27series = function () {
    return on_document$27dom(click$27dom, function (e) {
      let b$27498;
      (b$27498 = closest_of$27dom(e, "[data-series-view]"));
      if ((b$27498) !== false) {
        return cookie_set$21$27page("reel-series-view", data_of$27dom(b$27498, "series-view"), 31536000);
      } else {
        return false;
      }
    });
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
  series_views$27series();
});
