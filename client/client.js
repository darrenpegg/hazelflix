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
$B["string-split"] = (s, sep) => $list(...s.split(sep));
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
const $build = { version: "0.3.2416+2569d9a6.dirty", commit: "2569d9a6", branch: "main" };

// the program
$run(() => {
  let add_class$21$27dom, address$27page, after$27page, again$27intro, alert$21$27page, append$21$27dom, as_queue$27remote, ask$27page, ask_where$27music, ask_where$27where, ask_which$27where, asked$27where, asked_href$27where, at_once$27photos, attribute_of$27dom, audio_close$21$27audio, audio_context$27audio, audio_now$27audio, audio_resume$21$27audio, audio_running$3f$27audio, back$21$27page, bar_key$27bar, bar_player$27bar, bar_wake$21$27bar, biquad$27audio, body$27dom, body_of$27dom, browser_id$27socket, by_id$27dom, cancel_timer$21$27page, capture_pointer$21$27dom, change$27dom, checked$3f$27dom, children_of$27dom, chime_notes$27intro, chimes$27intro, choices$27playlist, choose$27ui, chosen_files$27fetch, clear$21$27dom, clear_source$21$27media, click$27dom, clock$27clock, close$27dom, close_dialog$21$27dom, closest_of$27dom, confirmed$3f$27page, connect$21$27audio, connect$27socket, controls$27remote, converting_refreshes$27search, cookie_get$27page, cookie_set$21$27page, copy_content$21$27dom, data_of$27dom, default_prevented$3f$27dom, delay_node$27audio, destination$27audio, dialogs$3f$27dom, digits$3f$27bar, each_in$27picker, each_of$27intro, each_of$27photos, encode_component$27page, ended$27media, envelope$27intro, every$27page, fetch_text$27fetch, file_input_again$21$27fetch, file_name$27fetch, file_size$27fetch, film_back$27back, film_page$3f$27back, film_plays$27film, filters_apply$27search, first_element_of$27dom, focus$21$27dom, focus_window$21$27page, frame_step$27picker, full$3f$27keypad, fullscreen$21$27page, gain_node$27audio, go$21$27page, go$27bar, handlers$27socket, head_style$27page, heard$27socket, hidden$3f$27dom, hide$21$27remote, history_length$27page, id_of$27dom, import$21$27dom, in_use$3f$27socket, input$27dom, insert_before$21$27dom, intro_plays$27intro, intro_shows$27intro, join_names$27player, kept$3f$27bar, key_of$27dom, keydown$27dom, keypads_work$27keypad, link_address$27page, load$27dom, loadedmetadata$27media, make_element$27dom, make_player$27player, make_player_options$27player, media_by_id$27media, media_duration$27media, media_in$27media, media_paused$3f$27media, media_ready$3f$27media, media_session$21$27media, media_time$27media, mousemove$27dom, music_buttons$27music, muted$3f$27media, new_playlist$27playlist, noise_source$27audio, note$27ui, nothing$27bar, now_ms$27page, nth$27saver, number_of$27film, number_of$27picker, number_of_field$27film, on$27dom, on_document$27dom, on_media_key$27media, on_once$27dom, on_window$27page, only_able$27where, open_socket$27socket, open_window$27page, opener_session_get$27page, origin$27page, oscillator$27audio, other_screens$27where, outline$27subtitles, page_client$27socket, page_title$27page, pagehide$27page, pages_swap$27bar, panner$27audio, param$27audio, part_in$27dom, partials$27intro, path$27page, pause$21$27media, pause$27media, pending$27playlist, photo_dialog$27photos, photos_page$27photos, picker_runs$27picker, picker_work$27picker, pickers_work$27picker, piece$27photos, place_pin$27photos, plain_click$3f$27dom, play$21$27media, play$27media, play_then$21$27media, play_where$27where, player$3f$27player, player_current$27player, player_link$3f$27where, player_media$27player, player_options$3f$27player, player_options_asleep$27player, player_options_bar$27player, player_options_film$27player, player_options_on_load$27player, player_options_on_sleep$27player, player_options_on_wake$27player, player_playing$3f$27player, player_position$27player, player_queue$27player, player_reload$27player, player_send$27player, player_sleep$27player, player_state$27player, player_wake$27player, players_start$27bar, playlists_add$27playlist, plays$27film, pointer_x$27dom, pointer_y$27dom, pointerdown$27dom, pointermove$27dom, pointerup$27dom, pop_out$27playlist, popstate$27page, post_form$21$27fetch, post_piece_watched$21$27fetch, prevent_default$21$27dom, previous_of$27dom, push_address$21$27page, query$27dom, query_all$27dom, query_all_in$27dom, query_has$3f$27page, query_in$27dom, query_with$27page, queue_now$27player, quiet_ms$27photos, ramp_to$21$27audio, random$27page, read_page$27page, ready_to_play$27ready, real_of$27said, rect_of$27dom, referrer$27page, reload$21$27page, reload_when_free$27socket, reloading$27socket, remote_controls$27remote, remove$21$27dom, remove_class$21$27dom, replace_address$21$27page, resize$27page, saver_runs$27saver, saver_shows$27saver, screen_of$27where, screen_plays$27ready, scroll_to_top$21$27page, search_as_typed$27search, search_now$27search, seek$21$27media, seeked$27media, self$27socket, send$27music, send_to$27where, sent$27where, series_views$27series, session_get$27page, session_remove$21$27page, session_set$21$27page, set_at$21$27audio, set_attribute$21$27dom, set_class$21$27dom, set_field$21$27dom, set_hidden$21$27dom, set_muted$21$27media, set_page_style$21$27dom, set_page_title$21$27page, set_poster$21$27media, set_source$21$27media, set_style$21$27dom, set_text$21$27dom, set_title$21$27dom, set_value$21$27audio, set_volume$21$27media, show_modal$21$27dom, show_subtitles$21$27media, shown_ms$27saver, site_path$27bar, socket_address$27browser$2fsocket, socket_open$27browser$2fsocket, socket_send$21$27browser$2fsocket, sound$27intro, stale$21$27socket, start$21$27audio, start_player$27player, stop$21$27audio, submit$27dom, submit_form$21$27dom, subtitle_previews$27subtitles, subtitles_showing$3f$27media, swappable$3f$27bar, tab$27socket, tab_id$27socket, tag_of$27dom, targets$27where, text$21$27ready, text$21$27remote, text_of$27dom, this_page$27dom, time_text$27picker, timeupdate$27media, toggle_class$21$27dom, touchstart$27dom, tries$27photos, user_agent$27page, value_of$27dom, volume$27media, volumechange$27media, wait$27socket, waiting$27where, with_pairs$27player, without$27saver;
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
      ($B["equal?"]($B["map-ref"](msg$275, "type", ""), "you") ? (set_page_style$21$27dom("--safe-w", $B["string-append"]($B["number->string"]($B["map-ref"](msg$275, "safe_w", 80)), "vw")), set_page_style$21$27dom("--safe-h", $B["string-append"]($B["number->string"]($B["map-ref"](msg$275, "safe_h", 90)), "vh")), (self$27socket = $theMap(msg$275)), ((($B["equal?"]($B["map-ref"](msg$275, "client", ""), "") === false) ? ($B["equal?"]($B["map-ref"](msg$275, "client", ""), page_client$27socket()) === false) : false) ? (stale$21$27socket, (reloading$27socket ? false : ((reloading$27socket = true), reload_when_free$27socket()))) : false)) : false);
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
  (page_client$27socket = function () {
    let s$277;
    (s$277 = query$27dom("script[data-client]"));
    if ((s$277) !== false) {
      return data_of$27dom(s$277, "client");
    } else {
      return "";
    }
  });
  (in_use$3f$27socket = function () {
    let all$278, loop$279;
    (all$278 = query_all$27dom("video, audio"));
    (loop$279 = function (i) {
      let m$2710, or$27value$2711;
      for (;;) {
        if ((i === $B["vector-length"](all$278))) {
          return false;
        } else {
          (m$2710 = $B["vector-ref"](all$278, i));
          if (((or$27value$2711 = (media_paused$3f$27media(m$2710) === false)), (or$27value$2711 ? or$27value$2711 : ((media_time$27media(m$2710) > 0.0) ? (media_time$27media(m$2710) < (media_duration$27media(m$2710) - 1.0)) : false)))) {
            return true;
          } else {
            const $t0 = (i + 1);
            i = $t0;
            continue;
          }
        }
      }
    });
    return loop$279(0);
  });
  (reloading$27socket = false);
  (stale$21$27socket = function () {
    if (reloading$27socket) {
      return false;
    } else {
      (reloading$27socket = true);
      return reload_when_free$27socket();
    }
  });
  (reload_when_free$27socket = function () {
    if ((in_use$3f$27socket()) !== false) {
      return after$27page(10000, reload_when_free$27socket);
    } else {
      return reload$21$27page();
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
    let digits$3f, rest$2713;
    (digits$3f = function (s, i) {
      let b$2712;
      for (;;) {
        if ((i === $B["string-length"](s))) {
          return (i > 0);
        } else {
          (b$2712 = $B["byte-ref"](s, i));
          if ((b$2712 >= 48)) {
            if ((b$2712 <= 57)) {
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
      (rest$2713 = $B["substring"](p, 6, $B["string-length"](p)));
      return digits$3f(($B["string-suffix?"]("/", rest$2713) ? $B["substring"](rest$2713, 0, ($B["string-length"](rest$2713) - 1)) : rest$2713), 0);
    } else {
      return false;
    }
  });
  (film_back$27back = function () {
    let brand$2714;
    (brand$2714 = query$27dom("[data-brand]"));
    if (((brand$2714) !== false ? ((film_page$3f$27back(path$27page())) !== false ? ($B["string-prefix?"]($B["string-append"](origin$27page(), "/"), referrer$27page()) ? (history_length$27page() >= 2) : false) : false) : false)) {
      set_title$21$27dom(brand$2714, "Back");
      return on$27dom(brand$2714, click$27dom, function (e) {
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
    let url$2715;
    (url$2715 = $B["string-append"]("/search?q=", encode_component$27page(value_of$27dom(box))));
    return fetch_text$27fetch(url$2715, function (status, html) {
      let main$2717, page$2716, sheet$2721, style$2719, their_sheet$2722, their_style$2720, theirs$2718;
      (page$2716 = read_page$27page(html));
      (main$2717 = query$27dom("main"));
      (theirs$2718 = query_in$27dom(page$2716, "main"));
      (style$2719 = query$27dom("style"));
      (their_style$2720 = query_in$27dom(page$2716, "style"));
      (sheet$2721 = query$27dom("link[data-sheet]"));
      (their_sheet$2722 = query_in$27dom(page$2716, "link[data-sheet]"));
      if ((((main$2717) !== false ? ((theirs$2718) !== false ? (status === 200) : false) : false)) !== false) {
        ((((style$2719) !== false ? their_style$2720 : false)) !== false ? copy_content$21$27dom(style$2719, their_style$2720) : false);
        (((sheet$2721) !== false ? ((their_sheet$2722) !== false ? ($B["equal?"](attribute_of$27dom(sheet$2721, "href"), attribute_of$27dom(their_sheet$2722, "href")) === false) : false) : false) ? set_attribute$21$27dom(sheet$2721, "href", attribute_of$27dom(their_sheet$2722, "href")) : false);
        copy_content$21$27dom(main$2717, theirs$2718);
        set_attribute$21$27dom(main$2717, "class", attribute_of$27dom(theirs$2718, "class"));
        replace_address$21$27page(url$2715);
        return focus$21$27dom(box);
      } else {
        return false;
      }
    });
  });
  (search_as_typed$27search = function () {
    let box$2723, typing$2724;
    (box$2723 = query$27dom("input[data-search]"));
    (typing$2724 = 0);
    if ((box$2723) !== false) {
      return on$27dom(box$2723, input$27dom, function (e) {
        cancel_timer$21$27page(typing$2724);
        return (typing$2724 = after$27page(250, function () {
          return search_now$27search(box$2723);
        }));
      });
    } else {
      return false;
    }
  });
  (filters_apply$27search = function () {
    let each$2726, filters$2725;
    (filters$2725 = query_all$27dom("[data-filter]"));
    (each$2726 = function (i) {
      let f$2727;
      if ((i < $B["vector-length"](filters$2725))) {
        (f$2727 = $B["vector-ref"](filters$2725, i));
        on$27dom(f$2727, change$27dom, function (e) {
          return submit_form$21$27dom(f$2727);
        });
        return each$2726((i + 1));
      } else {
        return false;
      }
    });
    return each$2726(0);
  });
  (converting_refreshes$27search = function () {
    let n$2729, refresh$2728;
    (refresh$2728 = query$27dom("[data-refresh]"));
    if ((refresh$2728) !== false) {
      return after$27page((1000 * ((n$2729 = $B["string->number"](data_of$27dom(refresh$2728, "refresh"))), ((n$2729) !== false ? $B["exact"](n$2729) : 30))), function () {
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
    let intro$2730;
    (intro$2730 = by_id$27dom("intro"));
    if ((intro$2730) !== false) {
      return intro_shows$27intro(intro$2730);
    } else {
      return false;
    }
  });
  (intro_shows$27intro = function (intro) {
    let audio$2731, begin_playing$2736, gone$2733, leave$2734, or$27value$2741, or$27value$2742, or$27value$2743, show$2737, start$2735, started$2732;
    (audio$2731 = false);
    (started$2732 = false);
    (gone$2733 = false);
    (leave$2734 = function () {
      let done$2738;
      if (gone$2733) {
        return false;
      } else {
        (gone$2733 = true);
        add_class$21$27dom(intro, "leaving");
        after$27page(600, function () {
          return set_hidden$21$27dom(intro, true);
        });
        (done$2738 = audio$2731);
        if ((done$2738) !== false) {
          return after$27page(4000, function () {
            return audio_close$21$27audio(done$2738);
          });
        } else {
          return false;
        }
      }
    });
    (start$2735 = function () {
      if (started$2732) {
        return false;
      } else {
        (started$2732 = true);
        add_class$21$27dom(intro, "playing");
        (((audio$2731) !== false ? audio_running$3f$27audio(audio$2731) : false) ? sound$27intro(audio$2731) : false);
        return after$27page(3700, leave$2734);
      }
    });
    (begin_playing$2736 = function () {
      if (((audio$2731) !== false ? (audio_running$3f$27audio(audio$2731) === false) : false)) {
        return audio_resume$21$27audio(audio$2731, start$2735);
      } else {
        return start$2735();
      }
    });
    (show$2737 = function (asked) {
      let or$27value$2739, or$27value$2740;
      (audio$2731 = audio_context$27audio());
      (started$2732 = false);
      (gone$2733 = false);
      remove_class$21$27dom(intro, "leaving");
      remove_class$21$27dom(intro, "playing");
      set_hidden$21$27dom(intro, false);
      if ((((or$27value$2739 = asked), (or$27value$2739 ? or$27value$2739 : ((or$27value$2740 = (audio$2731 === false)), (or$27value$2740 ? or$27value$2740 : ((audio$2731) !== false ? audio_running$3f$27audio(audio$2731) : false)))))) !== false) {
        return begin_playing$2736();
      } else {
        return false;
      }
    });
    on$27dom(intro, click$27dom, function (e) {
      if (started$2732) {
        return leave$2734();
      } else {
        return begin_playing$2736();
      }
    });
    on_document$27dom(keydown$27dom, function (e) {
      if (gone$2733) {
        return false;
      } else {
        if ($B["equal?"](key_of$27dom(e), "Escape")) {
          return leave$2734();
        } else {
          if ((started$2732 === false)) {
            return begin_playing$2736();
          } else {
            return false;
          }
        }
      }
    });
    (again$27intro = function () {
      return show$2737(true);
    });
    if ((((or$27value$2741 = by_id$27dom("player")), ((or$27value$2741) !== false ? or$27value$2741 : ((or$27value$2742 = by_id$27dom("ready")), ((or$27value$2742) !== false ? or$27value$2742 : ((or$27value$2743 = query$27dom("[data-profiles]")), ((or$27value$2743) !== false ? or$27value$2743 : query$27dom("[data-help]")))))))) !== false) {
      return false;
    } else {
      if ((($B["equal?"](session_get$27page("hazelflix-intro"), "") === false) ? (query_has$3f$27page("intro") === false) : false)) {
        return false;
      } else {
        if ((session_set$21$27page("hazelflix-intro", "1") === false)) {
          return false;
        } else {
          return show$2737(false);
        }
      }
    }
  });
  (envelope$27intro = function (g, at, attack, peak, hold, release) {
    let p$2744;
    (p$2744 = param$27audio(g, "gain"));
    set_at$21$27audio(p$2744, 0.0001, 0.0);
    set_at$21$27audio(p$2744, 0.0001, at);
    ramp_to$21$27audio(p$2744, peak, (at + attack));
    set_at$21$27audio(p$2744, peak, (at + (attack + hold)));
    return ramp_to$21$27audio(p$2744, 0.0001, (at + (attack + (hold + release))));
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
    let at$2755, band$2753, echo$2747, feedback$2748, hg$2754, hiss$2752, note$2757, notes$2758, open$2756, out$2746, t0$2745, wet$2749;
    (t0$2745 = (audio_now$27audio(c) + 0.050000000000000003));
    (out$2746 = gain_node$27audio(c));
    (echo$2747 = delay_node$27audio(c, 1.0));
    (feedback$2748 = gain_node$27audio(c));
    (wet$2749 = gain_node$27audio(c));
    set_value$21$27audio(param$27audio(out$2746, "gain"), 0.69999999999999996);
    connect$21$27audio(out$2746, destination$27audio(c));
    set_value$21$27audio(param$27audio(echo$2747, "delayTime"), 0.27000000000000002);
    set_value$21$27audio(param$27audio(feedback$2748, "gain"), 0.32000000000000001);
    set_value$21$27audio(param$27audio(wet$2749, "gain"), 0.28000000000000003);
    connect$21$27audio(echo$2747, feedback$2748);
    connect$21$27audio(feedback$2748, echo$2747);
    connect$21$27audio(echo$2747, wet$2749);
    connect$21$27audio(wet$2749, destination$27audio(c));
    connect$21$27audio(out$2746, echo$2747);
    each_of$27intro(new Pair(49.0, new Pair(49.600000000000001, null)), function (f) {
      let g$2751, o$2750;
      (o$2750 = oscillator$27audio(c, "sine"));
      (g$2751 = gain_node$27audio(c));
      set_at$21$27audio(param$27audio(o$2750, "frequency"), f, t0$2745);
      ramp_to$21$27audio(param$27audio(o$2750, "frequency"), (f * 1.1200000000000001), (t0$2745 + 2.2999999999999998));
      envelope$27intro(g$2751, t0$2745, 1.6000000000000001, 0.32000000000000001, 0.59999999999999998, 1.6000000000000001);
      connect$21$27audio(o$2750, g$2751);
      connect$21$27audio(g$2751, out$2746);
      start$21$27audio(o$2750, t0$2745);
      return stop$21$27audio(o$2750, (t0$2745 + 4.2000000000000002));
    });
    ((hiss$2752 = noise_source$27audio(c, 2.0)), (band$2753 = biquad$27audio(c, "bandpass")), (hg$2754 = gain_node$27audio(c)), set_value$21$27audio(param$27audio(band$2753, "Q"), 6.0), set_at$21$27audio(param$27audio(band$2753, "frequency"), 700.0, (t0$2745 + 1.1000000000000001)), ramp_to$21$27audio(param$27audio(band$2753, "frequency"), 7000.0, (t0$2745 + 2.2999999999999998)), envelope$27intro(hg$2754, (t0$2745 + 1.1000000000000001), 0.69999999999999996, 0.089999999999999997, 0.29999999999999999, 0.5), connect$21$27audio(hiss$2752, band$2753), connect$21$27audio(band$2753, hg$2754), connect$21$27audio(hg$2754, out$2746), start$21$27audio(hiss$2752, (t0$2745 + 1.1000000000000001)), stop$21$27audio(hiss$2752, (t0$2745 + 3.1000000000000001)));
    (at$2755 = (t0$2745 + 2.2999999999999998));
    (open$2756 = biquad$27audio(c, "lowpass"));
    set_at$21$27audio(param$27audio(open$2756, "frequency"), 500.0, at$2755);
    ramp_to$21$27audio(param$27audio(open$2756, "frequency"), 3000.0, (at$2755 + 1.2));
    connect$21$27audio(open$2756, out$2746);
    (note$2757 = function (f, i) {
      return each_of$27intro(new Pair(-6.0, new Pair(6.0, null)), function (cents) {
        let g$2760, o$2759;
        (o$2759 = oscillator$27audio(c, "triangle"));
        (g$2760 = gain_node$27audio(c));
        set_value$21$27audio(param$27audio(o$2759, "frequency"), f);
        set_value$21$27audio(param$27audio(o$2759, "detune"), cents);
        envelope$27intro(g$2760, (at$2755 + (i * 0.02)), 0.40000000000000002, 0.040000000000000001, 0.59999999999999998, 2.3999999999999999);
        connect$21$27audio(o$2759, g$2760);
        connect$21$27audio(g$2760, open$2756);
        start$21$27audio(o$2759, at$2755);
        return stop$21$27audio(o$2759, (at$2755 + 3.6000000000000001));
      });
    });
    (notes$2758 = function (l, i) {
      for (;;) {
        if ($B["null?"](l)) {
          return true;
        } else {
          note$2757($B["car"](l), i);
          const $t0 = $B["cdr"](l);
          const $t1 = (i + 1.0);
          l = $t0;
          i = $t1;
          continue;
        }
      }
    });
    notes$2758(new Pair(110.0, new Pair(164.81, new Pair(220.0, new Pair(277.18000000000001, new Pair(329.63, null))))), 0.0);
    return chimes$27intro(c, out$2746, at$2755);
  });
  (chime_notes$27intro = $B["vector"](880.0, 987.76999999999998, 1108.73, 1318.51, 1479.98, 1760.0, 1975.53, 2217.46));
  (partials$27intro = new Pair(new Pair(1.0, new Pair(1.0, new Pair(3.2000000000000002, null))), new Pair(new Pair(2.7599999999999998, new Pair(0.41999999999999998, new Pair(1.8999999999999999, null))), new Pair(new Pair(5.4000000000000004, new Pair(0.20000000000000001, new Pair(1.1000000000000001, null))), new Pair(new Pair(8.9299999999999997, new Pair(0.089999999999999997, new Pair(0.59999999999999998, null))), null)))));
  (chimes$27intro = function (c, out, at) {
    let strike;
    (strike = function (i, when, gap, last) {
      let first$2761, n$2762, place$2764, strength$2763;
      if ((i < 11)) {
        (first$2761 = $B["exact"]($B["floor"]((random$27page() * 8))));
        (n$2762 = ((first$2761 === last) ? $B["modulo"]((first$2761 + (1 + $B["exact"]($B["floor"]((random$27page() * 3))))), 8) : first$2761));
        (strength$2763 = (0.074999999999999997 * ((1.0 - ($B["inexact"](i) / 14.0)) * (0.69999999999999996 + (random$27page() * 0.5)))));
        (place$2764 = panner$27audio(c));
        ((place$2764) !== false ? (set_value$21$27audio(param$27audio(place$2764, "pan"), ((random$27page() * 1.3999999999999999) - 0.69999999999999996)), connect$21$27audio(place$2764, out)) : false);
        each_of$27intro(partials$27intro, function (p) {
          return each_of$27intro(new Pair(-4.0, new Pair(4.0, null)), function (cents) {
            let g$2766, o$2765, ring$2767;
            (o$2765 = oscillator$27audio(c, "sine"));
            (g$2766 = gain_node$27audio(c));
            (ring$2767 = $B["car"]($B["cdr"]($B["cdr"](p))));
            set_value$21$27audio(param$27audio(o$2765, "frequency"), ($B["vector-ref"](chime_notes$27intro, n$2762) * $B["car"](p)));
            set_value$21$27audio(param$27audio(o$2765, "detune"), (cents + ((random$27page() * 4.0) - 2.0)));
            set_at$21$27audio(param$27audio(g$2766, "gain"), 0.0001, when);
            ramp_to$21$27audio(param$27audio(g$2766, "gain"), (strength$2763 * $B["car"]($B["cdr"](p))), (when + 0.0040000000000000001));
            ramp_to$21$27audio(param$27audio(g$2766, "gain"), 0.0001, (when + ring$2767));
            connect$21$27audio(o$2765, g$2766);
            connect$21$27audio(g$2766, ((place$2764) !== false ? place$2764 : out));
            start$21$27audio(o$2765, when);
            return stop$21$27audio(o$2765, (when + (ring$2767 + 0.050000000000000003)));
          });
        });
        return strike((i + 1), (when + (gap + (random$27page() * gap))), (gap * 1.22), n$2762);
      } else {
        return true;
      }
    });
    return strike(0, (at + 0.02), 0.070000000000000007, -1);
  });
  (clock$27clock = function (s) {
    let h$2769, m$2770, n$27i2, n$27i3, t$2768;
    (t$2768 = ((s > 0.0) ? $B["exact"]($B["floor"](s)) : 0));
    (h$2769 = $B["quotient"](t$2768, 3600));
    (m$2770 = $B["quotient"]($B["remainder"](t$2768, 3600), 60));
    return $B["string-append"](((h$2769 > 0) ? $B["string-append"]($B["number->string"](h$2769), ":", ((n$27i2 = m$2770), ((n$27i2 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i2)) : $B["number->string"](n$27i2)))) : $B["number->string"](m$2770)), ":", ((n$27i3 = $B["remainder"](t$2768, 60)), ((n$27i3 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i3)) : $B["number->string"](n$27i3))));
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
    let art$2774, asleep$2786, bar$2787, current$2792, current$27i80, dragging$2783, expected$2793, film_of$2788, handler$27i62, handler$27i63, handler$27i65, handler$27i68, heard$2782, items$2790, labels$21$2795, list_items$27100, listed$2784, live$2785, load$27dom$2796, loaded$2780, media$2773, media$27i85, number_in$27104, offset$2781, play_or_not$2797, playing$3f$27i81, position$2794, position$27i79, queue$27i82, queues$21$27101, received$2779, reload$27i84, render$2798, row$21$2799, seek$2775, select$27151, send$2791, send$27i78, sleep$27103, sleep$27i77, start$2776, state$2778, state$27i83, told$2789, volume$27media$27167, wake$27102, wake$27i76, wanted$2777, x$27i4;
    (media$2773 = media_in$27media(root, "[data-p=media]"));
    (art$2774 = part_in$27dom(root, $B["string-append"]("[data-p=", "art", "]"), "img"));
    (seek$2775 = part_in$27dom(root, $B["string-append"]("[data-p=", "seek", "]"), "input"));
    (start$2776 = part_in$27dom(root, $B["string-append"]("[data-p=", "start", "]"), "button"));
    (wanted$2777 = ((x$27i4 = $B["string->number"](data_of$27dom(root, "queue"))), $B["exact"]($B["floor"](real_of$27said(x$27i4)))));
    (state$2778 = false);
    (received$2779 = 0.0);
    (loaded$2780 = 0);
    (offset$2781 = 0.0);
    (heard$2782 = false);
    (dragging$2783 = false);
    (listed$2784 = "");
    (live$2785 = false);
    (asleep$2786 = $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 0, options));
    (bar$2787 = $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 1, options));
    (asleep$2786 ? false : (queue_now$27player = wanted$2777));
    (film_of$2788 = function (item) {
      let kind$2771$27i5, or$27value$2772$27i6;
      if (((kind$2771$27i5 = $B["map-ref"](item, "kind", "")), ((or$27value$2772$27i6 = $B["equal?"](kind$2771$27i5, "film")), (or$27value$2772$27i6 ? or$27value$2772$27i6 : $B["equal?"](kind$2771$27i5, "episode"))))) {
        return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 2, options)(item);
      } else {
        return false;
      }
    });
    (told$2789 = function () {
      if ((state$2778) !== false) {
        return state$2778;
      } else {
        return $B["map-of"]();
      }
    });
    (items$2790 = function () {
      return $B["map-ref"](told$2789(), "items", $B["vector"]());
    });
    (send$2791 = function (op, extra) {
      let msg$27i7;
      (msg$27i7 = with_pairs$27player($B["map-of"]("type", "queue", "op", op, "queue", ((state$2778) !== false ? $B["map-ref"](told$2789(), "id", 0) : wanted$2777)), extra));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i7));
      } else {
        return false;
      }
    });
    (current$2792 = function () {
      if (($B["vector-length"](items$2790()) > 0)) {
        return $B["vector-ref"](items$2790(), $B["map-ref"](told$2789(), "at", 0));
      } else {
        return false;
      }
    });
    (expected$2793 = function () {
      let x$27i8;
      return (real_of$27said($B["map-ref"](told$2789(), "position", 0)) + (((x$27i8 = $B["map-ref"](told$2789(), "paused", false)), ((x$27i8) !== false ? (((x$27i8 === $sym("null")) === false) ? (($B["equal?"](x$27i8, 0) === false) ? ($B["equal?"](x$27i8, "") === false) : false) : false) : false)) ? 0.0 : ((now_ms$27page() - received$2779) / 1000.0)));
    });
    (position$2794 = function () {
      return (offset$2781 + media_time$27media(media$2773));
    });
    (labels$21$2795 = function (item, artist_text, artist_href, album_text, album_href) {
      let album$27106, artist$27105, before$27107, x$27i9;
      set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "title", "]"), "span"), ((x$27i9 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i9) ? x$27i9 : ($B["number?"](x$27i9) ? $B["number->string"](x$27i9) : ""))));
      (artist$27105 = part_in$27dom(root, $B["string-append"]("[data-p=", "artist", "]"), "a"));
      (album$27106 = part_in$27dom(root, $B["string-append"]("[data-p=", "album", "]"), "a"));
      set_text$21$27dom(artist$27105, artist_text);
      set_attribute$21$27dom(artist$27105, "href", artist_href);
      set_text$21$27dom(album$27106, album_text);
      set_attribute$21$27dom(album$27106, "href", album_href);
      (before$27107 = previous_of$27dom(album$27106));
      if ((before$27107) !== false) {
        return set_hidden$21$27dom(before$27107, $B["equal?"](album_text, ""));
      } else {
        return false;
      }
    });
    (load$27dom$2796 = function (item) {
      let at$27109, e$27110, or$27value$27113, or$27value$27114, p$27108, pictured$27112, src$27111, x$27i10, x$27i11, x$27i12, x$27i13, x$27i14, x$27i15, x$27i16, x$27i17, x$27i18, x$27i19, x$27i20, x$27i21, x$27i22, x$27i23, x$27i24, x$27i25, x$27i26, x$27i27, x$27i28;
      (p$27108 = film_of$2788(item));
      (at$27109 = ((e$27110 = ((x$27i10 = expected$2793()), $B["exact"]($B["floor"](real_of$27said(x$27i10))))), ((e$27110 > 0) ? e$27110 : 0)));
      (loaded$2780 = ((x$27i11 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i11)))));
      (heard$2782 = false);
      ((p$27108) !== false ? ((live$2785 = (((x$27i12 = $B["map-ref"](p$27108, "ready", false)), ((x$27i12) !== false ? (((x$27i12 === $sym("null")) === false) ? (($B["equal?"](x$27i12, 0) === false) ? ($B["equal?"](x$27i12, "") === false) : false) : false) : false)) === false)), (offset$2781 = (live$2785 ? real_of$27said(at$27109) : 0.0)), set_source$21$27media(media$2773, (live$2785 ? $B["string-append"]("/live/", ((x$27i13 = $B["map-ref"](p$27108, "file", 0)), ($B["string?"](x$27i13) ? x$27i13 : ($B["number?"](x$27i13) ? $B["number->string"](x$27i13) : ""))), "?t=", $B["number->string"](at$27109), (((x$27i14 = $B["map-ref"](p$27108, "format", 0)), ((x$27i14) !== false ? (((x$27i14 === $sym("null")) === false) ? (($B["equal?"](x$27i14, 0) === false) ? ($B["equal?"](x$27i14, "") === false) : false) : false) : false)) ? $B["string-append"]("&format=", ((x$27i15 = $B["map-ref"](p$27108, "format", 0)), ($B["string?"](x$27i15) ? x$27i15 : ($B["number?"](x$27i15) ? $B["number->string"](x$27i15) : "")))) : "")) : ((x$27i16 = $B["map-ref"](p$27108, "source", "")), ($B["string?"](x$27i16) ? x$27i16 : ($B["number?"](x$27i16) ? $B["number->string"](x$27i16) : "")))))) : ((src$27111 = ((x$27i17 = $B["map-ref"](item, "src", "")), ($B["string?"](x$27i17) ? x$27i17 : ($B["number?"](x$27i17) ? $B["number->string"](x$27i17) : "")))), (live$2785 = ((x$27i18 = $B["map-ref"](item, "live", false)), ((x$27i18) !== false ? (((x$27i18 === $sym("null")) === false) ? (($B["equal?"](x$27i18, 0) === false) ? ($B["equal?"](x$27i18, "") === false) : false) : false) : false))), (offset$2781 = (live$2785 ? real_of$27said(at$27109) : 0.0)), set_source$21$27media(media$2773, (live$2785 ? $B["string-append"](src$27111, "?t=", $B["number->string"](at$27109)) : src$27111))));
      (((live$2785 === false) ? (at$27109 > 0) : false) ? on_once$27dom(media$2773, loadedmetadata$27media, function (e) {
        return seek$21$27media(media$2773, expected$2793());
      }) : false);
      ((pictured$27112 = ((or$27value$27113 = ((p$27108) !== false ? true : false)), (or$27value$27113 ? or$27value$27113 : $B["equal?"]($B["map-ref"](item, "kind", ""), "video")))), set_hidden$21$27dom(media$2773, ((or$27value$27114 = (pictured$27112 === false)), (or$27value$27114 ? or$27value$27114 : bar$2787))), set_hidden$21$27dom(art$2774, (pictured$27112 ? (bar$2787 === false) : false)));
      set_attribute$21$27dom(art$2774, "src", ((x$27i19 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i19) ? x$27i19 : ($B["number?"](x$27i19) ? $B["number->string"](x$27i19) : ""))));
      labels$21$2795(item, ((x$27i20 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i20) ? x$27i20 : ($B["number?"](x$27i20) ? $B["number->string"](x$27i20) : ""))), $B["string-append"]("/artist/", ((x$27i21 = $B["map-ref"](item, "artist_id", "")), ($B["string?"](x$27i21) ? x$27i21 : ($B["number?"](x$27i21) ? $B["number->string"](x$27i21) : "")))), ((x$27i22 = $B["map-ref"](item, "album", "")), ($B["string?"](x$27i22) ? x$27i22 : ($B["number?"](x$27i22) ? $B["number->string"](x$27i22) : ""))), (((x$27i23 = $B["map-ref"](item, "album_id", 0)), ((x$27i23) !== false ? (((x$27i23 === $sym("null")) === false) ? (($B["equal?"](x$27i23, 0) === false) ? ($B["equal?"](x$27i23, "") === false) : false) : false) : false)) ? $B["string-append"]("/album/", ((x$27i24 = $B["map-ref"](item, "album_id", 0)), ($B["string?"](x$27i24) ? x$27i24 : ($B["number?"](x$27i24) ? $B["number->string"](x$27i24) : "")))) : "#"));
      media_session$21$27media(((x$27i25 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i25) ? x$27i25 : ($B["number?"](x$27i25) ? $B["number->string"](x$27i25) : ""))), ((x$27i26 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i26) ? x$27i26 : ($B["number?"](x$27i26) ? $B["number->string"](x$27i26) : ""))), ((x$27i27 = $B["map-ref"](item, "album", "")), ($B["string?"](x$27i27) ? x$27i27 : ($B["number?"](x$27i27) ? $B["number->string"](x$27i27) : ""))), ((x$27i28 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i28) ? x$27i28 : ($B["number?"](x$27i28) ? $B["number->string"](x$27i28) : ""))));
      return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 3, options)(item, p$27108);
    });
    (play_or_not$2797 = function () {
      let x$27i29;
      if (((x$27i29 = $B["map-ref"](told$2789(), "paused", false)), ((x$27i29) !== false ? (((x$27i29 === $sym("null")) === false) ? (($B["equal?"](x$27i29, 0) === false) ? ($B["equal?"](x$27i29, "") === false) : false) : false) : false))) {
        return pause$21$27media(media$2773);
      } else {
        return play_then$21$27media(media$2773, function () {
          return set_hidden$21$27dom(start$2776, true);
        }, function () {
          return set_hidden$21$27dom(start$2776, false);
        });
      }
    });
    (render$2798 = function () {
      let how$27124, item$27115, item$27i30, kind$2771$27i31, me$27119, n$27116, names$27120, off$27117, or$27value$2772$27i32, others$27121, players$27118, repeat$27123, shuffle$27122, title$27125, x$27i33, x$27i34, x$27i35, x$27i36, x$27i37, x$27i38, x$27i39, x$27i41, x$27i42, x$27i43, x$27i44;
      (item$27115 = current$2792());
      (n$27116 = $B["vector-length"](items$2790()));
      set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "count", "]"), "span"), ((n$27116 === 0) ? "" : ((n$27116 === 1) ? "1 item" : $B["string-append"]($B["number->string"](n$27116), " items"))));
      ((item$27115 === false) ? ((loaded$2780 = 0), pause$21$27media(media$2773), clear_source$21$27media(media$2773), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "title", "]"), "span"), "Nothing playing")) : ((((item$27i30 = item$27115), ((kind$2771$27i31 = $B["map-ref"](item$27i30, "kind", "")), ((or$27value$2772$27i32 = $B["equal?"](kind$2771$27i31, "film")), (or$27value$2772$27i32 ? or$27value$2772$27i32 : $B["equal?"](kind$2771$27i31, "episode"))))) ? (film_of$2788(item$27115) === false) : false) ? (($B["equal?"]($B["map-ref"](item$27115, "id", 0), loaded$2780) ? false : ((loaded$2780 = ((x$27i33 = $B["map-ref"](item$27115, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i33))))), pause$21$27media(media$2773), clear_source$21$27media(media$2773), set_hidden$21$27dom(media$2773, true), set_hidden$21$27dom(art$2774, false), set_attribute$21$27dom(art$2774, "src", ((x$27i34 = $B["map-ref"](item$27115, "art", "")), ($B["string?"](x$27i34) ? x$27i34 : ($B["number?"](x$27i34) ? $B["number->string"](x$27i34) : "")))), labels$21$2795(item$27115, ((x$27i35 = $B["map-ref"](item$27115, "label", "")), ($B["string?"](x$27i35) ? x$27i35 : ($B["number?"](x$27i35) ? $B["number->string"](x$27i35) : ""))), ((x$27i36 = $B["map-ref"](item$27115, "src", "")), ($B["string?"](x$27i36) ? x$27i36 : ($B["number?"](x$27i36) ? $B["number->string"](x$27i36) : ""))), "", "#"))), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(expected$2793())), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "length", "]"), "span"), clock$27clock(real_of$27said($B["map-ref"](item$27115, "duration", 0)))), (dragging$2783 ? false : (set_attribute$21$27dom(seek$2775, "max", $B["number->string"](((x$27i37 = $B["map-ref"](item$27115, "duration", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i37)))))), set_field$21$27dom(seek$2775, $B["number->string"](((x$27i38 = expected$2793()), $B["exact"]($B["floor"](real_of$27said(x$27i38))))))))) : (($B["equal?"]($B["map-ref"](item$27115, "id", 0), loaded$2780) === false) ? (load$27dom$2796(item$27115), play_or_not$2797()) : (play_or_not$2797(), ((off$27117 = (position$2794() - expected$2793())), (((((x$27i39 = $B["map-ref"](told$2789(), "paused", false)), ((x$27i39) !== false ? (((x$27i39 === $sym("null")) === false) ? (($B["equal?"](x$27i39, 0) === false) ? ($B["equal?"](x$27i39, "") === false) : false) : false) : false)) === false) ? (media_ready$3f$27media(media$2773) ? (((off$27117 < 0.0) ? (0.0 - off$27117) : off$27117) > (live$2785 ? 3.0 : 1.0)) : false) : false) ? (live$2785 ? (load$27dom$2796(item$27115), play_or_not$2797()) : seek$21$27media(media$2773, expected$2793())) : false))))));
      ((players$27118 = $B["map-ref"](told$2789(), "players", $B["vector"]())), (me$27119 = browser_id$27socket()), (names$27120 = function (i) {
        let x$27i40;
        for (;;) {
          if ((i >= $B["vector-length"](players$27118))) {
            return null;
          } else {
            if ($B["equal?"]($B["map-ref"]($B["vector-ref"](players$27118, i), "id", ""), me$27119)) {
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return $B["cons"](((x$27i40 = $B["map-ref"]($B["vector-ref"](players$27118, i), "name", "")), ($B["string?"](x$27i40) ? x$27i40 : ($B["number?"](x$27i40) ? $B["number->string"](x$27i40) : ""))), names$27120((i + 1)));
            }
          }
        }
      }), ((others$27121 = ($B["vector?"](players$27118) ? names$27120(0) : null)), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "note", "]"), "span"), ($B["null?"](others$27121) ? "" : $B["string-append"]("Also playing on: ", join_names$27player(others$27121))))));
      set_hidden$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "play", "]"), "button"), (((x$27i41 = $B["map-ref"](told$2789(), "paused", false)), ((x$27i41) !== false ? (((x$27i41 === $sym("null")) === false) ? (($B["equal?"](x$27i41, 0) === false) ? ($B["equal?"](x$27i41, "") === false) : false) : false) : false)) === false));
      set_hidden$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "pause", "]"), "button"), ((x$27i42 = $B["map-ref"](told$2789(), "paused", false)), ((x$27i42) !== false ? (((x$27i42 === $sym("null")) === false) ? (($B["equal?"](x$27i42, 0) === false) ? ($B["equal?"](x$27i42, "") === false) : false) : false) : false)));
      ((shuffle$27122 = query_in$27dom(root, "[data-player=shuffle]")), (repeat$27123 = query_in$27dom(root, "[data-player=repeat]")), (how$27124 = ((x$27i43 = $B["map-ref"](told$2789(), "repeat", "off")), ($B["string?"](x$27i43) ? x$27i43 : ($B["number?"](x$27i43) ? $B["number->string"](x$27i43) : "")))), ((shuffle$27122) !== false ? toggle_class$21$27dom(shuffle$27122, "on", ((x$27i44 = $B["map-ref"](told$2789(), "shuffle", false)), ((x$27i44) !== false ? (((x$27i44 === $sym("null")) === false) ? (($B["equal?"](x$27i44, 0) === false) ? ($B["equal?"](x$27i44, "") === false) : false) : false) : false))) : false), ((repeat$27123) !== false ? ((title$27125 = $B["string-append"]("Repeat: ", ($B["equal?"](how$27124, "one") ? "this one" : how$27124))), toggle_class$21$27dom(repeat$27123, "on", ($B["equal?"](how$27124, "off") === false)), set_title$21$27dom(repeat$27123, title$27125), set_attribute$21$27dom(repeat$27123, "aria-label", title$27125)) : false));
      return list_items$27100();
    });
    (row$21$2799 = function (box, item, i) {
      let a$27138, act$21$27133, acts$27130, art$27131, kind$27132, n$27136, pic$27137, row$27126, sub$27129, tile$27135, title$27128, words$27127, x$27i45, x$27i46, x$27i47, x$27i48, x$27i49, x$27i50, x$27i51;
      (row$27126 = make_element$27dom("div"));
      (words$27127 = make_element$27dom("div"));
      (title$27128 = make_element$27dom("div"));
      (sub$27129 = make_element$27dom("div"));
      (acts$27130 = make_element$27dom("div"));
      (art$27131 = ((x$27i45 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i45) ? x$27i45 : ($B["number?"](x$27i45) ? $B["number->string"](x$27i45) : ""))));
      (kind$27132 = $B["map-ref"](item, "kind", ""));
      (act$21$27133 = function (name, mark, label) {
        let b$27134;
        (b$27134 = make_element$27dom("button"));
        set_attribute$21$27dom(b$27134, "type", "button");
        set_attribute$21$27dom(b$27134, "data-act", name);
        set_text$21$27dom(b$27134, mark);
        set_title$21$27dom(b$27134, label);
        set_attribute$21$27dom(b$27134, "aria-label", label);
        return append$21$27dom(acts$27130, b$27134);
      });
      set_class$21$27dom(row$27126, ((i === $B["map-ref"](told$2789(), "at", 0)) ? "queue-row now" : "queue-row"));
      set_attribute$21$27dom(row$27126, "data-item", ((x$27i46 = $B["map-ref"](item, "id", 0)), ($B["string?"](x$27i46) ? x$27i46 : ($B["number?"](x$27i46) ? $B["number->string"](x$27i46) : ""))));
      ($B["equal?"](art$27131, "") ? ((tile$27135 = make_element$27dom("div")), (n$27136 = (((x$27i47 = $B["map-ref"](item, "song", 0)), ((x$27i47) !== false ? (((x$27i47 === $sym("null")) === false) ? (($B["equal?"](x$27i47, 0) === false) ? ($B["equal?"](x$27i47, "") === false) : false) : false) : false)) ? ((x$27i48 = $B["map-ref"](item, "song", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i48)))) : ((x$27i49 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i49)))))), set_class$21$27dom(tile$27135, "queue-tile"), set_style$21$27dom(tile$27135, "background", $B["string-append"]("hsl(", $B["number->string"]($B["modulo"]((n$27136 * 47), 360)), ", 38%, 30%)")), append$21$27dom(row$27126, tile$27135)) : ((pic$27137 = make_element$27dom("img")), set_attribute$21$27dom(pic$27137, "src", art$27131), set_attribute$21$27dom(pic$27137, "alt", ""), set_attribute$21$27dom(pic$27137, "loading", "lazy"), append$21$27dom(row$27126, pic$27137)));
      set_style$21$27dom(words$27127, "min-width", "0");
      set_class$21$27dom(title$27128, "queue-title");
      set_text$21$27dom(title$27128, $B["string-append"](((x$27i50 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i50) ? x$27i50 : ($B["number?"](x$27i50) ? $B["number->string"](x$27i50) : ""))), ($B["equal?"](kind$27132, "video") ? "  (video)" : ($B["equal?"](kind$27132, "film") ? "  (film)" : ""))));
      set_class$21$27dom(sub$27129, "queue-sub");
      set_text$21$27dom(sub$27129, $B["string-append"](((a$27138 = ((x$27i51 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i51) ? x$27i51 : ($B["number?"](x$27i51) ? $B["number->string"](x$27i51) : "")))), ($B["equal?"](a$27138, "") ? "" : $B["string-append"](a$27138, " \xc2\xb7 "))), clock$27clock(real_of$27said($B["map-ref"](item, "duration", 0)))));
      append$21$27dom(words$27127, title$27128);
      append$21$27dom(words$27127, sub$27129);
      act$21$27133("up", "\xe2\x96\xb2", "Up");
      act$21$27133("down", "\xe2\x96\xbc", "Down");
      act$21$27133("remove", "\xe2\x9c\x95", "Remove");
      append$21$27dom(row$27126, words$27127);
      append$21$27dom(row$27126, acts$27130);
      return append$21$27dom(box, row$27126);
    });
    (list_items$27100 = function () {
      let all$27140, box$27139, each$27145, ids$27141, key$27142, or$27value$27143, p$27144, x$27i53;
      (box$27139 = query_in$27dom(root, "[data-p=items]"));
      (all$27140 = items$2790());
      (ids$27141 = function (i) {
        let x$27i52;
        if ((i >= $B["vector-length"](all$27140))) {
          return "";
        } else {
          return $B["string-append"](",", ((x$27i52 = $B["map-ref"]($B["vector-ref"](all$27140, i), "id", 0)), ($B["string?"](x$27i52) ? x$27i52 : ($B["number?"](x$27i52) ? $B["number->string"](x$27i52) : ""))), ids$27141((i + 1)));
        }
      });
      (key$27142 = $B["string-append"](((x$27i53 = $B["map-ref"](told$2789(), "at", 0)), ($B["string?"](x$27i53) ? x$27i53 : ($B["number?"](x$27i53) ? $B["number->string"](x$27i53) : ""))), ":", ids$27141(0)));
      if (((or$27value$27143 = (box$27139 === false)), (or$27value$27143 ? or$27value$27143 : $B["equal?"](key$27142, listed$2784)))) {
        return false;
      } else {
        (listed$2784 = key$27142);
        clear$21$27dom(box$27139);
        if (($B["vector-length"](all$27140) === 0)) {
          (p$27144 = make_element$27dom("p"));
          set_style$21$27dom(p$27144, "color", "var(--muted, #888)");
          set_text$21$27dom(p$27144, "Empty. Play an album, an artist or a song from Music, or add one with +.");
          return append$21$27dom(box$27139, p$27144);
        } else {
          (each$27145 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](all$27140))) {
                row$21$2799(box$27139, $B["vector-ref"](all$27140, i), i);
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          });
          return each$27145(0);
        }
      }
    });
    (queues$21$27101 = function (l) {
      let each$27147, select$27146, x$27i57;
      (select$27146 = query_in$27dom(root, "[data-p=queue]"));
      if ((select$27146) !== false) {
        clear$21$27dom(select$27146);
        ((each$27147 = function (i) {
          let o$27149, q$27148, x$27i54, x$27i55, x$27i56;
          for (;;) {
            if ((i < $B["vector-length"](l))) {
              (q$27148 = $B["vector-ref"](l, i));
              (o$27149 = make_element$27dom("option"));
              set_attribute$21$27dom(o$27149, "value", ((x$27i54 = $B["map-ref"](q$27148, "id", 0)), ($B["string?"](x$27i54) ? x$27i54 : ($B["number?"](x$27i54) ? $B["number->string"](x$27i54) : ""))));
              set_text$21$27dom(o$27149, $B["string-append"](((x$27i55 = $B["map-ref"](q$27148, "name", "")), ($B["string?"](x$27i55) ? x$27i55 : ($B["number?"](x$27i55) ? $B["number->string"](x$27i55) : ""))), " (", ((x$27i56 = $B["map-ref"](q$27148, "n", 0)), ($B["string?"](x$27i56) ? x$27i56 : ($B["number?"](x$27i56) ? $B["number->string"](x$27i56) : ""))), ")"));
              append$21$27dom(select$27146, o$27149);
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return false;
            }
          }
        }), each$27147(0));
        if ((state$2778) !== false) {
          return set_field$21$27dom(select$27146, ((x$27i57 = $B["map-ref"](told$2789(), "id", 0)), ($B["string?"](x$27i57) ? x$27i57 : ($B["number?"](x$27i57) ? $B["number->string"](x$27i57) : ""))));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    (wake$27102 = function (queue) {
      let msg$27i58;
      (asleep$2786 = false);
      (wanted$2777 = queue);
      (loaded$2780 = 0);
      (listed$2784 = "");
      $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 4, options)();
      (msg$27i58 = $B["map-of"]("type", "player", "queue", wanted$2777));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i58));
      } else {
        return false;
      }
    });
    (sleep$27103 = function () {
      let msg$27i59;
      (asleep$2786 = true);
      (state$2778 = false);
      (loaded$2780 = 0);
      pause$21$27media(media$2773);
      clear_source$21$27media(media$2773);
      $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 5, options)();
      (msg$27i59 = $B["map-of"]("type", "player", "stop", true));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i59));
      } else {
        return false;
      }
    });
    (number_in$27104 = function (e) {
      let x$27i60;
      (x$27i60 = $B["string->number"](value_of$27dom(e)));
      return $B["exact"]($B["floor"](real_of$27said(x$27i60)));
    });
    ((handler$27i62 = function (text, m) {
      let msg$27i61;
      if (asleep$2786) {
        return false;
      } else {
        (msg$27i61 = $B["map-of"]("type", "player", "queue", wanted$2777));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i61));
        } else {
          return false;
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i62)))));
    ((handler$27i63 = function (text, m) {
      return queues$21$27101($B["map-ref"](m, "queues", $B["vector"]()));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queues", $B["append"]($B["map-ref"](handlers$27socket, "queues", null), $listFromEnd(handler$27i63)))));
    ((handler$27i65 = function (text, m) {
      let or$27value$27150, x$27i64;
      if ((((or$27value$27150 = asleep$2786), (or$27value$27150 ? or$27value$27150 : ((wanted$2777 > 0) ? ($B["equal?"]($B["map-ref"](m, "id", 0), wanted$2777) === false) : false)))) !== false) {
        return false;
      } else {
        (wanted$2777 = ((x$27i64 = $B["map-ref"](m, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i64)))));
        (queue_now$27player = wanted$2777);
        (state$2778 = m);
        (received$2779 = now_ms$27page());
        set_field$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "queue", "]"), "select"), $B["number->string"](wanted$2777));
        ((($B["equal?"](path$27page(), "/music/player") ? (bar$2787 === false) : false)) !== false ? replace_address$21$27page($B["string-append"]("/music/player?", query_with$27page("queue", $B["number->string"](wanted$2777)))) : false);
        return render$2798();
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue", $B["append"]($B["map-ref"](handlers$27socket, "queue", null), $listFromEnd(handler$27i65)))));
    ((handler$27i68 = function (text, m) {
      let msg$27i67, x$27i66;
      if (asleep$2786) {
        return false;
      } else {
        (wanted$2777 = ((x$27i66 = $B["map-ref"](m, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i66)))));
        (msg$27i67 = $B["map-of"]("type", "player", "queue", wanted$2777));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i67));
        } else {
          return false;
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue-made", $B["append"]($B["map-ref"](handlers$27socket, "queue-made", null), $listFromEnd(handler$27i68)))));
    ((select$27151 = part_in$27dom(root, $B["string-append"]("[data-p=", "queue", "]"), "select")), on$27dom(select$27151, change$27dom, function (e) {
      let msg$27i69;
      (wanted$2777 = number_in$27104(select$27151));
      (loaded$2780 = 0);
      (msg$27i69 = $B["map-of"]("type", "player", "queue", wanted$2777));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i69));
      } else {
        return false;
      }
    }));
    on$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "new", "]"), "button"), click$27dom, function (e) {
      let msg$27i70, name$27152;
      (name$27152 = ask$27page("The new queue's name", ""));
      if ((name$27152) !== false) {
        (msg$27i70 = $B["map-of"]("type", "queue", "op", "new", "name", name$27152));
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
      let act$27157, all$27158, button$27156, control$27153, find$27160, item$27155, place$27159, row$27154, x$27i71;
      (control$27153 = closest_of$27dom(e, "[data-player]"));
      if ((control$27153) !== false) {
        return send$2791(data_of$27dom(control$27153, "player"), null);
      } else {
        (row$27154 = closest_of$27dom(e, ".queue-row"));
        if ((((row$27154) !== false ? state$2778 : false)) !== false) {
          (item$27155 = ((x$27i71 = $B["string->number"](data_of$27dom(row$27154, "item"))), $B["exact"]($B["floor"](real_of$27said(x$27i71)))));
          (button$27156 = closest_of$27dom(e, "[data-act]"));
          (act$27157 = ((button$27156) !== false ? data_of$27dom(button$27156, "act") : ""));
          (all$27158 = items$2790());
          (place$27159 = ((find$27160 = function (i) {
            for (;;) {
              if ((i >= $B["vector-length"](all$27158))) {
                return -1;
              } else {
                if ($B["equal?"]($B["map-ref"]($B["vector-ref"](all$27158, i), "id", 0), item$27155)) {
                  return i;
                } else {
                  const $t0 = (i + 1);
                  i = $t0;
                  continue;
                }
              }
            }
          }), find$27160(0)));
          if ($B["equal?"](act$27157, "remove")) {
            return send$2791("remove", $listFromEnd($B["cons"]("item", item$27155)));
          } else {
            if (($B["equal?"](act$27157, "up") ? (place$27159 > 0) : false)) {
              return send$2791("move", $listFromEnd($B["cons"]("to", (place$27159 - 1)), $B["cons"]("item", item$27155)));
            } else {
              if (($B["equal?"](act$27157, "down") ? (place$27159 < ($B["vector-length"](all$27158) - 1)) : false)) {
                return send$2791("move", $listFromEnd($B["cons"]("to", (place$27159 + 1)), $B["cons"]("item", item$27155)));
              } else {
                if ($B["equal?"](act$27157, "")) {
                  return send$2791("jump", $listFromEnd($B["cons"]("item", item$27155)));
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
    on$27dom(start$2776, click$27dom, function (e) {
      return play_then$21$27media(media$2773, function () {
        return set_hidden$21$27dom(start$2776, true);
      }, function () {
        return false;
      });
    });
    on$27dom(media$2773, ended$27media, function (e) {
      let item$27161;
      (item$27161 = current$2792());
      if ((((item$27161) !== false ? (asleep$2786 === false) : false)) !== false) {
        return send$2791("ended", $listFromEnd($B["cons"]("item", $B["map-ref"](item$27161, "id", 0))));
      } else {
        return false;
      }
    });
    on$27dom(media$2773, timeupdate$27media, function (e) {
      let at$27163, d$27166, half$27165, item$27162, length$27164, x$27i72, x$27i73, x$27i74;
      (item$27162 = current$2792());
      if ((((item$27162) !== false ? (asleep$2786 === false) : false)) !== false) {
        (at$27163 = position$2794());
        (length$27164 = ((d$27166 = real_of$27said($B["map-ref"](item$27162, "duration", 0))), ((d$27166 > 0.0) ? d$27166 : media_duration$27media(media$2773))));
        (half$27165 = (length$27164 / 2.0));
        (((heard$2782 === false) ? (((x$27i72 = $B["map-ref"](item$27162, "song", 0)), ((x$27i72) !== false ? (((x$27i72 === $sym("null")) === false) ? (($B["equal?"](x$27i72, 0) === false) ? ($B["equal?"](x$27i72, "") === false) : false) : false) : false)) ? (at$27163 > ((half$27165 < 240.0) ? half$27165 : 240.0)) : false) : false) ? ((heard$2782 = true), send$2791("heard", $listFromEnd($B["cons"]("song", $B["map-ref"](item$27162, "song", 0))))) : false);
        (dragging$2783 ? false : (set_attribute$21$27dom(seek$2775, "max", $B["number->string"](((x$27i73 = length$27164), $B["exact"]($B["floor"](real_of$27said(x$27i73)))))), set_field$21$27dom(seek$2775, $B["number->string"](((x$27i74 = at$27163), $B["exact"]($B["floor"](real_of$27said(x$27i74))))))));
        set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock((dragging$2783 ? real_of$27said(number_in$27104(seek$2775)) : at$27163)));
        return set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "length", "]"), "span"), clock$27clock(length$27164));
      } else {
        return false;
      }
    });
    on$27dom(seek$2775, input$27dom, function (e) {
      (dragging$2783 = true);
      return set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(real_of$27said(number_in$27104(seek$2775))));
    });
    on$27dom(seek$2775, change$27dom, function (e) {
      (dragging$2783 = false);
      return send$2791("seek", $listFromEnd($B["cons"]("value", number_in$27104(seek$2775))));
    });
    ((volume$27media$27167 = part_in$27dom(root, $B["string-append"]("[data-p=", "volume", "]"), "input")), on$27dom(volume$27media$27167, input$27dom, function (e) {
      return set_volume$21$27media(media$2773, (real_of$27said(number_in$27104(volume$27media$27167)) / 100.0));
    }));
    on_media_key$27media("play", function () {
      if (asleep$2786) {
        return false;
      } else {
        return send$2791("toggle", null);
      }
    });
    on_media_key$27media("pause", function () {
      if (asleep$2786) {
        return false;
      } else {
        return send$2791("toggle", null);
      }
    });
    on_media_key$27media("nexttrack", function () {
      if (asleep$2786) {
        return false;
      } else {
        return send$2791("next", null);
      }
    });
    on_media_key$27media("previoustrack", function () {
      if (asleep$2786) {
        return false;
      } else {
        return send$2791("prev", null);
      }
    });
    every$27page(2000, function () {
      let x$27i75;
      if ((((asleep$2786 === false) ? ((state$2778) !== false ? ((((x$27i75 = $B["map-ref"](told$2789(), "paused", false)), ((x$27i75) !== false ? (((x$27i75 === $sym("null")) === false) ? (($B["equal?"](x$27i75, 0) === false) ? ($B["equal?"](x$27i75, "") === false) : false) : false) : false)) === false) ? current$2792() : false) : false) : false)) !== false) {
        return render$2798();
      } else {
        return false;
      }
    });
    (wake$27i76 = wake$27102);
    (sleep$27i77 = sleep$27103);
    (send$27i78 = send$2791);
    (position$27i79 = position$2794);
    (current$27i80 = current$2792);
    (playing$3f$27i81 = function () {
      return (asleep$2786 === false);
    });
    (queue$27i82 = function () {
      return wanted$2777;
    });
    (state$27i83 = function () {
      return state$2778;
    });
    (reload$27i84 = function () {
      (loaded$2780 = 0);
      if ((((state$2778) !== false ? (asleep$2786 === false) : false)) !== false) {
        return render$2798();
      } else {
        return false;
      }
    });
    (media$27i85 = media$2773);
    return $B["%record-make"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", wake$27i76, sleep$27i77, send$27i78, position$27i79, current$27i80, playing$3f$27i81, queue$27i82, state$27i83, reload$27i84, media$27i85);
  });
  (note$27ui = function (words) {
    let n$27168;
    (n$27168 = make_element$27dom("div"));
    set_class$21$27dom(n$27168, "music-note");
    set_text$21$27dom(n$27168, words);
    append$21$27dom(body$27dom(), n$27168);
    after$27page(2500, function () {
      return remove$21$27dom(n$27168);
    });
    return false;
  });
  (choose$27ui = function (title, choices) {
    let d$27169, each$27172, heading$27170, option$27171;
    (d$27169 = make_element$27dom("dialog"));
    (heading$27170 = make_element$27dom("h2"));
    set_class$21$27dom(d$27169, "reel-where");
    set_text$21$27dom(heading$27170, title);
    append$21$27dom(d$27169, heading$27170);
    (option$27171 = function (label, act, $class) {
      let b$27173;
      (b$27173 = make_element$27dom("button"));
      set_text$21$27dom(b$27173, label);
      ($B["equal?"]($class, "") ? false : set_class$21$27dom(b$27173, $class));
      on$27dom(b$27173, click$27dom, function (e) {
        close_dialog$21$27dom(d$27169);
        return act();
      });
      return append$21$27dom(d$27169, b$27173);
    });
    (each$27172 = function (l) {
      for (;;) {
        if ($B["null?"](l)) {
          return true;
        } else {
          option$27171($B["car"]($B["car"](l)), $B["cdr"]($B["car"](l)), "");
          const $t0 = $B["cdr"](l);
          l = $t0;
          continue;
        }
      }
    });
    each$27172(choices);
    option$27171("Cancel", function () {
      return false;
    }, "reel-cancel");
    on$27dom(d$27169, close$27dom, function (e) {
      return remove$21$27dom(d$27169);
    });
    append$21$27dom(body$27dom(), d$27169);
    return show_modal$21$27dom(d$27169);
  });
  (pending$27playlist = false);
  (choices$27playlist = function (what, playlists, i, out) {
    let p$27174;
    if ((i < 0)) {
      return out;
    } else {
      (p$27174 = $B["vector-ref"](playlists, i));
      return choices$27playlist(what, playlists, (i - 1), $B["cons"]($B["cons"]($B["string-append"]($B["map-ref"](p$27174, "name"), $B["string-append"](" (", $B["string-append"]($B["number->string"]($B["map-ref"](p$27174, "n", 0)), ")"))), function () {
        let msg$27i86$27i88, playlist$27i87;
        (playlist$27i87 = $B["map-ref"](p$27174, "id"));
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
    let msg$27i89, name$27175;
    (name$27175 = ask$27page("The new playlist's name", ""));
    if ((name$27175) !== false) {
      (msg$27i89 = $B["map-of"]("type", "playlist", "op", "new", "name", name$27175, "what", $B["map-ref"](what, "what"), "id", $B["map-ref"](what, "id")));
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
    let handler$27i91, handler$27i92, save$27179;
    on_document$27dom(click$27dom, function (e) {
      let b$27176, msg$27i90, n$27177;
      (b$27176 = closest_of$27dom(e, "[data-playlist-add]"));
      if ((b$27176) !== false) {
        prevent_default$21$27dom(e);
        (pending$27playlist = $B["map-of"]("what", data_of$27dom(b$27176, "playlist-add"), "id", ((n$27177 = $B["string->number"](data_of$27dom(b$27176, "id"))), ((n$27177) !== false ? n$27177 : 0))));
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
      let what$27178;
      (what$27178 = pending$27playlist);
      if ((what$27178) !== false) {
        return choose$27ui("Add to a playlist", $B["append"](choices$27playlist(what$27178, $B["map-ref"](m, "playlists", $B["vector"]()), ($B["vector-length"]($B["map-ref"](m, "playlists", $B["vector"]())) - 1), null), $listFromEnd($B["cons"]("New playlist\xe2\x80\xa6", function () {
          return new_playlist$27playlist(what$27178);
        }))));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "playlists", $B["append"]($B["map-ref"](handlers$27socket, "playlists", null), $listFromEnd(handler$27i91)))));
    ((handler$27i92 = function (text, m) {
      (pending$27playlist = false);
      return note$27ui($B["string-append"]((($B["map-ref"](m, "n", 1) === 1) ? "Added to " : $B["string-append"]($B["number->string"]($B["map-ref"](m, "n", 1)), " added to ")), $B["string-append"]($B["map-ref"](m, "name", ""), ".")));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "playlist-added", $B["append"]($B["map-ref"](handlers$27socket, "playlist-added", null), $listFromEnd(handler$27i92)))));
    (save$27179 = by_id$27dom("player-save"));
    if ((save$27179) !== false) {
      return on$27dom(save$27179, click$27dom, function (e) {
        let msg$27i93, name$27180, queue$27181;
        (name$27180 = ask$27page("The playlist's name", ""));
        (queue$27181 = queue_now$27player);
        if (((name$27180) !== false ? (queue$27181 > 0) : false)) {
          (msg$27i93 = $B["map-of"]("type", "playlist", "op", "new", "name", name$27180, "what", "queue", "id", queue$27181));
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
    let buttons$27182, each$27183;
    (query_has$3f$27page("popout") ? ((buttons$27182 = query_all$27dom("[data-popout]")), (each$27183 = function (i) {
      for (;;) {
        if ((i < $B["vector-length"](buttons$27182))) {
          set_hidden$21$27dom($B["vector-ref"](buttons$27182, i), true);
          const $t0 = (i + 1);
          i = $t0;
          continue;
        } else {
          return false;
        }
      }
    }), each$27183(0)) : false);
    return on_document$27dom(click$27dom, function (e) {
      let b$27184, q$27187, queue$27185, w$27186;
      (b$27184 = closest_of$27dom(e, "[data-popout]"));
      if ((b$27184) !== false) {
        (queue$27185 = ((q$27187 = queue_now$27player), ((q$27187 > 0) ? q$27187 : $B["map-ref"](self$27socket, "queue", 0))));
        (w$27186 = open_window$27page($B["string-append"]("/music/player?popout=1", ((queue$27185 > 0) ? $B["string-append"]("&queue=", $B["number->string"](queue$27185)) : "")), "hazelflix-player", "popup,width=460,height=780"));
        prevent_default$21$27dom(e);
        if ((w$27186 === false)) {
          return alert$21$27page("The browser didn't open the window: allow pop-ups for HazelFlix.");
        } else {
          focus_window$21$27page(w$27186);
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
    let n$27188;
    (n$27188 = $B["string->number"](data_of$27dom(e, name)));
    if ((n$27188) !== false) {
      return $theReal((n$27188 + 0.0));
    } else {
      return 0.0;
    }
  });
  (film_plays$27film = function () {
    let video$27189;
    (video$27189 = media_by_id$27media("player"));
    if ((video$27189) !== false) {
      return plays$27film(video$27189);
    } else {
      return false;
    }
  });
  (plays$27film = function (video) {
    let dragging$27205, duration$27193, f$27196, file$27191, film$27190, format$27192, live$27194, offset$27195, position$27197, report$27198, seek$27203, show$27206, start$27201, time$27204;
    (film$27190 = data_of$27dom(video, "film"));
    (file$27191 = data_of$27dom(video, "file"));
    (format$27192 = ((f$27196 = data_of$27dom(video, "format")), ($B["equal?"](f$27196, "") ? "0" : f$27196)));
    (duration$27193 = number_of$27film(video, "duration"));
    (live$27194 = $B["equal?"](data_of$27dom(video, "live"), "1"));
    (offset$27195 = (live$27194 ? number_of$27film(video, "start") : 0.0));
    (position$27197 = function () {
      return (offset$27195 + media_time$27media(video));
    });
    (report$27198 = function (going) {
      let at$27199, length$27200, msg$27i96, x$27i94, x$27i95;
      (at$27199 = ((x$27i94 = position$27197()), ($B["round"]((10.0 * x$27i94)) / 10.0)));
      (length$27200 = ((x$27i95 = ((duration$27193 > 0.0) ? duration$27193 : media_duration$27media(video))), ($B["round"]((10.0 * x$27i95)) / 10.0)));
      if (((going === false) ? ((msg$27i96 = $B["map-of"]("type", "progress", "film", $B["string->number"](film$27190), "file", $B["string->number"](file$27191), "position", at$27199, "duration", length$27200)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i96)) : false)) : false)) {
        return false;
      } else {
        return post_form$21$27fetch("/progress", $B["string-append"]("film=", encode_component$27page(film$27190), "&file=", encode_component$27page(file$27191), "&position=", $realText(at$27199), "&duration=", $realText(length$27200)));
      }
    });
    ((live$27194 === false) ? ((start$27201 = number_of$27film(video, "start")), ((start$27201 > 0.0) ? on_once$27dom(video, loadedmetadata$27media, function (e) {
      return seek$21$27media(video, start$27201);
    }) : false)) : false);
    every$27page(10000, function () {
      if (media_paused$3f$27media(video)) {
        return false;
      } else {
        return report$27198(false);
      }
    });
    on$27dom(video, pause$27media, function (e) {
      return report$27198(false);
    });
    on$27dom(video, ended$27media, function (e) {
      let next$27202;
      report$27198(false);
      (next$27202 = data_of$27dom(video, "next"));
      if ($B["equal?"](next$27202, "")) {
        return false;
      } else {
        return after$27page(1500, function () {
          return go$21$27page(next$27202);
        });
      }
    });
    on_window$27page(pagehide$27page, function (e) {
      return report$27198(true);
    });
    if (live$27194) {
      (seek$27203 = by_id$27dom("live-seek"));
      (time$27204 = by_id$27dom("live-time"));
      (dragging$27205 = false);
      (show$27206 = function (s) {
        if ((time$27204) !== false) {
          return set_text$21$27dom(time$27204, $B["string-append"](clock$27clock(s), " / ", clock$27clock(duration$27193)));
        } else {
          return false;
        }
      });
      on$27dom(video, timeupdate$27media, function (e) {
        (((seek$27203) !== false ? (dragging$27205 === false) : false) ? set_field$21$27dom(seek$27203, $B["number->string"]($B["exact"]($B["floor"](position$27197())))) : false);
        return show$27206(position$27197());
      });
      if ((seek$27203) !== false) {
        on$27dom(seek$27203, input$27dom, function (e) {
          (dragging$27205 = true);
          return show$27206(number_of_field$27film(seek$27203));
        });
        return on$27dom(seek$27203, change$27dom, function (e) {
          (dragging$27205 = false);
          (offset$27195 = number_of_field$27film(seek$27203));
          const $c0 = $B["floor"](offset$27195);
          if (!Number.isInteger($c0)) throw $notInteger;
          set_source$21$27media(video, $B["string-append"]("/live/", file$27191, "?t=", $B["number->string"]($c0), ($B["equal?"](format$27192, "0") ? "" : $B["string-append"]("&format=", format$27192))));
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
    let n$27207;
    (n$27207 = $B["string->number"](value_of$27dom(e)));
    if ((n$27207) !== false) {
      return $theReal((n$27207 + 0.0));
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
    let from$27209, me$27208;
    (me$27208 = $B["string-append"](browser_id$27socket(), $B["string-append"](".", tab$27socket)));
    (from$27209 = function (i) {
      for (;;) {
        if ((i < 0)) {
          return null;
        } else {
          if ($B["equal?"]($B["map-ref"]($B["vector-ref"](targets$27where, i), "id", ""), me$27208)) {
            const $t0 = (i - 1);
            i = $t0;
            continue;
          } else {
            return $B["cons"]($B["vector-ref"](targets$27where, i), from$27209((i - 1)));
          }
        }
      }
    });
    return $B["reverse"](from$27209(($B["vector-length"](targets$27where) - 1)));
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
    let msg$27i97, this$27210;
    if (((msg$27i97 = $B["map-of"]("type", "play", "target", $B["map-ref"](t, "id", ""), "href", href)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i97)) : false))) {
      (this$27210 = (sent$27where + 1));
      (sent$27where = this$27210);
      (waiting$27where = this$27210);
      return after$27page(5000, function () {
        if ((waiting$27where === this$27210)) {
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
      let t$27211;
      if ($B["null?"](l)) {
        return null;
      } else {
        (t$27211 = $B["car"](l));
        return $B["cons"]($B["cons"]($B["map-ref"](t$27211, "name", ""), function () {
          return send_to$27where(t$27211, href);
        }), choices($B["cdr"](l)));
      }
    });
    return choose$27ui("Play where?", $B["cons"]($B["cons"]("This browser", function () {
      return go$21$27page(href);
    }), choices(there)));
  });
  (ask_which$27where = function (href, there) {
    let msg$27i98, n$27212;
    (n$27212 = (asked$27where + 1));
    (asked$27where = n$27212);
    (asked_href$27where = href);
    if (((msg$27i98 = $B["map-of"]("type", "can-play", "n", n$27212, "href", href)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i98)) : false))) {
      return after$27page(1000, function () {
        if ((asked$27where === n$27212)) {
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
    let b$27213$27i100, b$27213$27i99;
    if ($B["string-prefix?"]("/play/", href)) {
      if ((6 < $B["string-length"](href))) {
        (b$27213$27i99 = $B["byte-ref"](href, 6));
        if ((b$27213$27i99 >= 48)) {
          return (b$27213$27i99 <= 57);
        } else {
          return false;
        }
      } else {
        return false;
      }
    } else {
      if ($B["string-prefix?"]("/watch/", href)) {
        if ((7 < $B["string-length"](href))) {
          (b$27213$27i100 = $B["byte-ref"](href, 7));
          if ((b$27213$27i100 >= 48)) {
            return (b$27213$27i100 <= 57);
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
      let able$27214, href$27215;
      if (((asked$27where > 0) ? ($B["map-ref"](m, "n", 0) === asked$27where) : false)) {
        (able$27214 = only_able$27where(other_screens$27where(), $B["map-ref"](m, "targets", $B["vector"]())));
        (href$27215 = asked_href$27where);
        (asked$27where = 0);
        if ($B["null?"](able$27214)) {
          return go$21$27page(href$27215);
        } else {
          return ask_where$27where(href$27215, able$27214);
        }
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "can-play", $B["append"]($B["map-ref"](handlers$27socket, "can-play", null), $listFromEnd(handler$27i104)))));
    return on_document$27dom(click$27dom, function (e) {
      let a$27216, href$27217, there$27218;
      (a$27216 = closest_of$27dom(e, "a[href]"));
      if (((a$27216) !== false ? ((default_prevented$3f$27dom(e) === false) ? (plain_click$3f$27dom(e) ? (by_id$27dom("ready") === false) : false) : false) : false)) {
        (href$27217 = attribute_of$27dom(a$27216, "href"));
        (there$27218 = other_screens$27where());
        if ((player_link$3f$27where(href$27217) ? (($B["null?"](there$27218) === false) ? dialogs$3f$27dom() : false) : false)) {
          prevent_default$21$27dom(e);
          return ask_which$27where(href$27217, there$27218);
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
  });
  (text$21$27ready = function (id, text) {
    let e$27219;
    (e$27219 = by_id$27dom(id));
    if ((e$27219) !== false) {
      return set_text$21$27dom(e$27219, text);
    } else {
      return false;
    }
  });
  (ready_to_play$27ready = function () {
    let ready$27220, video$27221;
    (ready$27220 = by_id$27dom("ready"));
    (video$27221 = media_by_id$27media("screen"));
    if ((((ready$27220) !== false ? video$27221 : false)) !== false) {
      return screen_plays$27ready(video$27221);
    } else {
      return false;
    }
  });
  (screen_plays$27ready = function (video) {
    let card$27225, duration$27234, film$27228, film$27i132, films$27226, handler$27i138, handler$27i145, handler$27i148, handler$27i164, item$27227, loaded$27238, on_load$27i133, on_sleep$27i135, on_wake$27i134, player$27230, reached$27229, report$27236, screen$27224, show_name$27233, start$27222, started$27232, state$27235, still$27231, stirred$27237, stop$27239, wait$27223;
    (start$27222 = by_id$27dom("ready-start"));
    (wait$27223 = by_id$27dom("ready-wait"));
    (screen$27224 = by_id$27dom("ready-screen"));
    (card$27225 = by_id$27dom("ready-card"));
    (films$27226 = $B["map-of"]());
    (item$27227 = false);
    (film$27228 = false);
    (reached$27229 = 0.0);
    (player$27230 = false);
    (still$27231 = 0);
    (started$27232 = function () {
      return player$27230;
    });
    (show_name$27233 = function () {
      let name$27240;
      (name$27240 = $B["map-ref"](self$27socket, "name", ""));
      if ($B["equal?"](name$27240, "")) {
        return false;
      } else {
        text$21$27ready("ready-hint-name", $B["string-append"]("\xe2\x80\x9c", name$27240, "\xe2\x80\x9d"));
        return text$21$27ready("ready-name", ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") ? $B["string-append"]("This screen is ", name$27240, ".") : $B["string-append"]("This screen is ", name$27240, ": set it to Play in Settings, Browsers, so others can send to it.")));
      }
    });
    (duration$27234 = function () {
      if ($B["map?"](film$27228)) {
        return real_of$27said($B["map-ref"](film$27228, "duration", 0));
      } else {
        if ($B["map?"](item$27227)) {
          return real_of$27said($B["map-ref"](item$27227, "duration", 0));
        } else {
          return 0.0;
        }
      }
    });
    (state$27235 = function () {
      let msg$27i111, r$27i105, x$27i106, x$27i107, x$27i108, x$27i109, x$27i110;
      (msg$27i111 = $B["map-of"]("type", "state", "playing", ($B["map?"](item$27227) ? true : false), "paused", media_paused$3f$27media(video), "position", ((x$27i106 = ((r$27i105 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i105))()), $B["exact"]($B["floor"](real_of$27said(x$27i106)))), "duration", ((x$27i107 = duration$27234()), $B["exact"]($B["floor"](real_of$27said(x$27i107)))), "title", ($B["map?"](item$27227) ? ((x$27i108 = $B["map-ref"](item$27227, "title", "")), ($B["string?"](x$27i108) ? x$27i108 : ($B["number?"](x$27i108) ? $B["number->string"](x$27i108) : ""))) : ""), "label", text_of$27dom(by_id$27dom("ready-label")), "poster", ($B["map?"](film$27228) ? ((x$27i109 = $B["map-ref"](film$27228, "poster", "")), ($B["string?"](x$27i109) ? x$27i109 : ($B["number?"](x$27i109) ? $B["number->string"](x$27i109) : ""))) : ($B["map?"](item$27227) ? ((x$27i110 = $B["map-ref"](item$27227, "art", "")), ($B["string?"](x$27i110) ? x$27i110 : ($B["number?"](x$27i110) ? $B["number->string"](x$27i110) : ""))) : "")), "volume", volume$27media(video), "muted", muted$3f$27media(video), "subtitles", ($B["map?"](film$27228) ? $B["map-ref"](film$27228, "subtitles", 0) : 0), "subtitlesOn", subtitles_showing$3f$27media(video), "next", ($B["map?"](film$27228) ? $B["map-ref"](film$27228, "next", 0) : 0)));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i111));
      } else {
        return false;
      }
    });
    (report$27236 = function () {
      let msg$27i114, x$27i112, x$27i113;
      if (($B["map?"](film$27228) ? (reached$27229 > 0.0) : false)) {
        (msg$27i114 = $B["map-of"]("type", "progress", "film", $B["map-ref"](film$27228, "film", 0), "file", $B["map-ref"](film$27228, "file", 0), "position", ((x$27i112 = reached$27229), ($B["round"]((10.0 * x$27i112)) / 10.0)), "duration", ((x$27i113 = real_of$27said($B["map-ref"](film$27228, "duration", 0))), ($B["round"]((10.0 * x$27i113)) / 10.0))));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i114));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    (stirred$27237 = function () {
      remove_class$21$27dom(screen$27224, "still");
      cancel_timer$21$27page(still$27231);
      return (still$27231 = after$27page(3000, function () {
        return add_class$21$27dom(screen$27224, "still");
      }));
    });
    (loaded$27238 = function (i, p) {
      let album$27242, art$27251, artist$27241, each$27244, each$27248, labels$27246, languages$27245, or$27value$27250, shown$27247, tracks$27243, x$27i115, x$27i116, x$27i117, x$27i118, x$27i119, x$27i120, x$27i121, x$27i124, x$27i125, x$27i126, x$27i127, x$27i128;
      report$27236();
      (item$27227 = i);
      (film$27228 = p);
      (reached$27229 = 0.0);
      text$21$27ready("ready-title", ((x$27i115 = $B["map-ref"](i, "title", "")), ($B["string?"](x$27i115) ? x$27i115 : ($B["number?"](x$27i115) ? $B["number->string"](x$27i115) : ""))));
      text$21$27ready("ready-label", ($B["map?"](p) ? ((x$27i116 = $B["map-ref"](p, "label", "")), ($B["string?"](x$27i116) ? x$27i116 : ($B["number?"](x$27i116) ? $B["number->string"](x$27i116) : ""))) : ((artist$27241 = ((x$27i117 = $B["map-ref"](i, "artist", "")), ($B["string?"](x$27i117) ? x$27i117 : ($B["number?"](x$27i117) ? $B["number->string"](x$27i117) : "")))), (album$27242 = ((x$27i118 = $B["map-ref"](i, "album", "")), ($B["string?"](x$27i118) ? x$27i118 : ($B["number?"](x$27i118) ? $B["number->string"](x$27i118) : "")))), ($B["equal?"](artist$27241, "") ? album$27242 : ($B["equal?"](album$27242, "") ? artist$27241 : $B["string-append"](artist$27241, " \xc2\xb7 ", album$27242))))));
      text$21$27ready("ready-time", "");
      show_subtitles$21$27media(video, -1);
      ((tracks$27243 = query_all_in$27dom(video, "track")), ((each$27244 = function (n) {
        for (;;) {
          if ((n < $B["vector-length"](tracks$27243))) {
            remove$21$27dom($B["vector-ref"](tracks$27243, n));
            const $t0 = (n + 1);
            n = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27244(0)));
      ($B["map?"](p) ? ((languages$27245 = $B["string-split"](((x$27i119 = $B["map-ref"](p, "subtitle-languages", "")), ($B["string?"](x$27i119) ? x$27i119 : ($B["number?"](x$27i119) ? $B["number->string"](x$27i119) : ""))), ",")), (labels$27246 = $B["string-split"](((x$27i120 = $B["map-ref"](p, "subtitle-labels", "")), ($B["string?"](x$27i120) ? x$27i120 : ($B["number?"](x$27i120) ? $B["number->string"](x$27i120) : ""))), ",")), (shown$27247 = ((x$27i121 = $B["map-ref"](p, "subtitle-shown", -1)), $B["exact"]($B["floor"](real_of$27said(x$27i121))))), ((each$27248 = function (n, ls, bs) {
        let t$27249, x$27i122, x$27i123;
        for (;;) {
          if ((n < ((x$27i122 = $B["map-ref"](p, "subtitles", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i122)))))) {
            (t$27249 = make_element$27dom("track"));
            set_attribute$21$27dom(t$27249, "kind", "subtitles");
            (($B["pair?"](ls) ? ($B["equal?"]($B["car"](ls), "") === false) : false) ? set_attribute$21$27dom(t$27249, "srclang", $B["car"](ls)) : false);
            ($B["pair?"](bs) ? set_attribute$21$27dom(t$27249, "label", $B["car"](bs)) : false);
            set_attribute$21$27dom(t$27249, "src", $B["string-append"]("/subs/", ((x$27i123 = $B["map-ref"](p, "file", 0)), ($B["string?"](x$27i123) ? x$27i123 : ($B["number?"](x$27i123) ? $B["number->string"](x$27i123) : ""))), "/", $B["number->string"](n)));
            ((n === shown$27247) ? set_attribute$21$27dom(t$27249, "default", "") : false);
            append$21$27dom(video, t$27249);
            const $t0 = (n + 1);
            const $t1 = ($B["pair?"](ls) ? $B["cdr"](ls) : ls);
            const $t2 = ($B["pair?"](bs) ? $B["cdr"](bs) : bs);
            n = $t0;
            ls = $t1;
            bs = $t2;
            continue;
          } else {
            return false;
          }
        }
      }), each$27248(0, languages$27245, labels$27246))) : false);
      set_poster$21$27media(video, ($B["map?"](p) ? ((x$27i124 = $B["map-ref"](p, "poster", "")), ($B["string?"](x$27i124) ? x$27i124 : ($B["number?"](x$27i124) ? $B["number->string"](x$27i124) : ""))) : ""));
      set_hidden$21$27dom(card$27225, ((or$27value$27250 = $B["map?"](p)), (or$27value$27250 ? or$27value$27250 : $B["equal?"]($B["map-ref"](i, "kind", ""), "video"))));
      text$21$27ready("ready-card-title", ((x$27i125 = $B["map-ref"](i, "title", "")), ($B["string?"](x$27i125) ? x$27i125 : ($B["number?"](x$27i125) ? $B["number->string"](x$27i125) : ""))));
      text$21$27ready("ready-card-artist", ((x$27i126 = $B["map-ref"](i, "artist", "")), ($B["string?"](x$27i126) ? x$27i126 : ($B["number?"](x$27i126) ? $B["number->string"](x$27i126) : ""))));
      text$21$27ready("ready-card-album", ((x$27i127 = $B["map-ref"](i, "album", "")), ($B["string?"](x$27i127) ? x$27i127 : ($B["number?"](x$27i127) ? $B["number->string"](x$27i127) : ""))));
      ((art$27251 = ((x$27i128 = $B["map-ref"](i, "art", "")), ($B["string?"](x$27i128) ? x$27i128 : ($B["number?"](x$27i128) ? $B["number->string"](x$27i128) : "")))), set_style$21$27dom(by_id$27dom("ready-card-back"), "background-image", ($B["equal?"](art$27251, "") ? "none" : $B["string-append"]("url(\"", art$27251, "\")"))));
      stirred$27237();
      return state$27235();
    });
    (stop$27239 = function () {
      let r$27i129, r$27i130, r$27i131;
      if (((r$27i129 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i129))()) {
        ((r$27i130 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i130))("pause", null);
        return ((r$27i131 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r$27i131))();
      } else {
        return false;
      }
    });
    (player$27230 = start_player$27player(screen$27224, ((film$27i132 = function (i) {
      return $B["map-ref"](films$27226, $B["map-ref"](i, "file", 0), false);
    }), (on_load$27i133 = loaded$27238), (on_wake$27i134 = function () {
      set_hidden$21$27dom(start$27222, true);
      set_hidden$21$27dom(wait$27223, true);
      set_hidden$21$27dom(screen$27224, false);
      stirred$27237();
      return false;
    }), (on_sleep$27i135 = function () {
      report$27236();
      (item$27227 = false);
      (film$27228 = false);
      set_hidden$21$27dom(screen$27224, true);
      set_hidden$21$27dom(wait$27223, (hidden$3f$27dom(start$27222) === false));
      state$27235();
      return false;
    }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", true, false, film$27i132, on_load$27i133, on_wake$27i134, on_sleep$27i135))));
    on$27dom(by_id$27dom("ready-go"), click$27dom, function (e) {
      play$21$27media(video);
      pause$21$27media(video);
      fullscreen$21$27page();
      set_hidden$21$27dom(start$27222, true);
      set_hidden$21$27dom(wait$27223, false);
      add_class$21$27dom(body$27dom(), "ready-on");
      show_name$27233();
      return again$27intro();
    });
    on$27dom(by_id$27dom("ready-home"), click$27dom, function (e) {
      return stop$27239();
    });
    on$27dom(video, timeupdate$27media, function (e) {
      let at$27252, length$27253, r$27i136;
      (at$27252 = ((r$27i136 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i136))());
      (length$27253 = duration$27234());
      (($B["map?"](item$27227) ? (media_time$27media(video) > 0.0) : false) ? (reached$27229 = at$27252) : false);
      return text$21$27ready("ready-time", (($B["map?"](item$27227) ? (length$27253 > 0.0) : false) ? $B["string-append"](clock$27clock(at$27252), " / ", clock$27clock((length$27253 - at$27252))) : ""));
    });
    on$27dom(video, ended$27media, function (e) {
      let q$27254, r$27i137;
      (q$27254 = ((r$27i137 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r$27i137))());
      if (((q$27254) !== false ? (($B["map-ref"](q$27254, "at", 0) >= ($B["vector-length"]($B["map-ref"](q$27254, "items", $B["vector"]())) - 1)) ? $B["equal?"]($B["map-ref"](q$27254, "repeat", ""), "off") : false) : false)) {
        report$27236();
        return after$27page(500, stop$27239);
      } else {
        return false;
      }
    });
    on$27dom(screen$27224, mousemove$27dom, function (e) {
      return stirred$27237();
    });
    on$27dom(screen$27224, pointerdown$27dom, function (e) {
      return stirred$27237();
    });
    on$27dom(screen$27224, touchstart$27dom, function (e) {
      return stirred$27237();
    });
    on_document$27dom(keydown$27dom, function (e) {
      if (hidden$3f$27dom(screen$27224)) {
        return false;
      } else {
        return stirred$27237();
      }
    });
    on$27dom(video, play$27media, function (e) {
      return state$27235();
    });
    on$27dom(video, pause$27media, function (e) {
      state$27235();
      return report$27236();
    });
    on$27dom(video, volumechange$27media, function (e) {
      return state$27235();
    });
    on$27dom(video, seeked$27media, function (e) {
      return state$27235();
    });
    every$27page(1000, function () {
      if (($B["map?"](item$27227) ? (media_paused$3f$27media(video) === false) : false)) {
        return state$27235();
      } else {
        return false;
      }
    });
    every$27page(10000, function () {
      if (($B["map?"](item$27227) ? (media_paused$3f$27media(video) === false) : false)) {
        return report$27236();
      } else {
        return false;
      }
    });
    ((handler$27i138 = function (text, m) {
      return show_name$27233();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i138)))));
    ((handler$27i145 = function (text, p) {
      let r$27i139, r$27i140, r$27i142, r$27i143, x$27i141, x$27i144;
      (films$27226 = $B["map-set"](films$27226, $B["map-ref"](p, "file", 0), p));
      if ((((r$27i139 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i139))() ? (((r$27i140 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i140))() === ((x$27i141 = $B["map-ref"](p, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i141))))) : false)) {
        return ((r$27i142 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 8, r$27i142))();
      } else {
        return ((r$27i143 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i143))(((x$27i144 = $B["map-ref"](p, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i144)))));
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "play", $B["append"]($B["map-ref"](handlers$27socket, "play", null), $listFromEnd(handler$27i145)))));
    ((handler$27i148 = function (text, m) {
      let r$27i146, x$27i147;
      return ((r$27i146 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i146))(((x$27i147 = $B["map-ref"](m, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i147)))));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "music", $B["append"]($B["map-ref"](handlers$27socket, "music", null), $listFromEnd(handler$27i148)))));
    (handler$27i164 = function (text, m) {
      let at$27257, c$27255, or$27value$27258, or$27value$27259, or$27value$27261, q$27256, r$27i149, r$27i150, r$27i151, r$27i154, r$27i155, r$27i157, r$27i159, r$27i161, r$27i162, r$27i163, v$27260, x$27i152, x$27i153, x$27i156, x$27i158, x$27i160;
      (c$27255 = $B["map-ref"](m, "command", ""));
      (q$27256 = ((r$27i149 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r$27i149))());
      (at$27257 = ((r$27i150 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i150))());
      ($B["equal?"](c$27255, "stop") ? stop$27239() : ((((r$27i151 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i151))() === false) ? false : (((or$27value$27258 = $B["equal?"](c$27255, "toggle")), (or$27value$27258 ? or$27value$27258 : ((or$27value$27259 = ($B["equal?"](c$27255, "play") ? ((q$27256) !== false ? ((x$27i152 = $B["map-ref"](q$27256, "paused", false)), ((x$27i152) !== false ? (((x$27i152 === $sym("null")) === false) ? (($B["equal?"](x$27i152, 0) === false) ? ($B["equal?"](x$27i152, "") === false) : false) : false) : false)) : false) : false)), (or$27value$27259 ? or$27value$27259 : ($B["equal?"](c$27255, "pause") ? ((q$27256) !== false ? (((x$27i153 = $B["map-ref"](q$27256, "paused", false)), ((x$27i153) !== false ? (((x$27i153 === $sym("null")) === false) ? (($B["equal?"](x$27i153, 0) === false) ? ($B["equal?"](x$27i153, "") === false) : false) : false) : false)) === false) : false) : false))))) ? ((r$27i154 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i154))("toggle", null) : ($B["equal?"](c$27255, "back") ? ((r$27i155 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i155))("seek", $listFromEnd($B["cons"]("value", ((v$27260 = ((x$27i156 = (at$27257 - 10.0)), $B["exact"]($B["floor"](real_of$27said(x$27i156))))), ((v$27260 > 0) ? v$27260 : 0))))) : ($B["equal?"](c$27255, "forward") ? ((r$27i157 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i157))("seek", $listFromEnd($B["cons"]("value", ((x$27i158 = (at$27257 + 30.0)), $B["exact"]($B["floor"](real_of$27said(x$27i158))))))) : ($B["equal?"](c$27255, "seek") ? ((r$27i159 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i159))("seek", $listFromEnd($B["cons"]("value", ((x$27i160 = $B["map-ref"](m, "value", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i160))))))) : ($B["equal?"](c$27255, "next") ? ((r$27i161 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i161))("next", null) : ($B["equal?"](c$27255, "prev") ? ((r$27i162 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i162))("prev", null) : ($B["equal?"](c$27255, "volume-down") ? set_volume$21$27media(video, (volume$27media(video) - 0.10000000000000001)) : ($B["equal?"](c$27255, "volume-up") ? (set_muted$21$27media(video, false), set_volume$21$27media(video, (volume$27media(video) + 0.10000000000000001))) : ($B["equal?"](c$27255, "mute") ? set_muted$21$27media(video, (muted$3f$27media(video) === false)) : ($B["equal?"](c$27255, "subtitles") ? show_subtitles$21$27media(video, (subtitles_showing$3f$27media(video) ? -1 : 0)) : false))))))))))));
      if ((((or$27value$27261 = $B["equal?"](c$27255, "stop")), (or$27value$27261 ? or$27value$27261 : ((r$27i163 = started$27232()), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i163))()))) !== false) {
        return state$27235();
      } else {
        return false;
      }
    });
    return (handlers$27socket = $B["map-set"](handlers$27socket, "control", $B["append"]($B["map-ref"](handlers$27socket, "control", null), $listFromEnd(handler$27i164))));
  });
  (hide$21$27remote = function (id, hidden) {
    let e$27262;
    (e$27262 = by_id$27dom(id));
    if ((e$27262) !== false) {
      return set_hidden$21$27dom(e$27262, hidden);
    } else {
      return false;
    }
  });
  (text$21$27remote = function (id, text) {
    let e$27263;
    (e$27263 = by_id$27dom(id));
    if ((e$27263) !== false) {
      return set_text$21$27dom(e$27263, text);
    } else {
      return false;
    }
  });
  (as_queue$27remote = $B["map-of"]("toggle", "toggle", "play", "toggle", "pause", "toggle", "next", "next", "prev", "prev", "seek", "seek", "back", "seek", "forward", "seek"));
  (remote_controls$27remote = function () {
    let remote$27264;
    (remote$27264 = by_id$27dom("remote"));
    if ((remote$27264) !== false) {
      return controls$27remote(remote$27264);
    } else {
      return false;
    }
  });
  (controls$27remote = function (remote) {
    let button$27337, chosen$27265, command$27287, dragging$27266, find_playing$27279, from_queue$27276, handler$27i189, handler$27i192, handler$27i193, handler$27i194, has$3f$27280, list$27338, listed$27274, listing$27273, names$27267, names_of$27281, others$27277, picked$27268, playing$3f$27278, queue_of$27275, queue_row$27286, queue_shape$27285, queues$27270, render$27283, seek$27272, seek_value$27288, show_queue$27284, states$27269, tab$21$27282, tabs$27271;
    (chosen$27265 = data_of$27dom(remote, "target"));
    (dragging$27266 = false);
    (names$27267 = "");
    (picked$27268 = ($B["equal?"](data_of$27dom(remote, "target"), "") === false));
    (states$27269 = $B["map-of"]());
    (queues$27270 = $B["map-of"]());
    (tabs$27271 = by_id$27dom("remote-tabs"));
    (seek$27272 = by_id$27dom("remote-seek"));
    (listing$27273 = false);
    (listed$27274 = "");
    (queue_of$27275 = function (t) {
      let x$27i165;
      if (($B["map?"](t) ? (((x$27i165 = $B["map-ref"](t, "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i165)))) > 0) : false)) {
        return $B["map-ref"](queues$27270, $B["map-ref"](t, "queue", 0), false);
      } else {
        return false;
      }
    });
    (from_queue$27276 = function (t) {
      let item$27290, kind$27291, or$27value$27293, paused$27292, q$27289, x$27i166, x$27i167, x$27i168, x$27i169, x$27i170, x$27i171;
      (q$27289 = queue_of$27275(t));
      if (((q$27289) !== false ? ($B["vector-length"]($B["map-ref"](q$27289, "items", $B["vector"]())) > 0) : false)) {
        (item$27290 = $B["vector-ref"]($B["map-ref"](q$27289, "items", $B["vector"]()), $B["map-ref"](q$27289, "at", 0)));
        (kind$27291 = $B["map-ref"](item$27290, "kind", ""));
        (paused$27292 = ((x$27i166 = $B["map-ref"](q$27289, "paused", false)), ((x$27i166) !== false ? (((x$27i166 === $sym("null")) === false) ? (($B["equal?"](x$27i166, 0) === false) ? ($B["equal?"](x$27i166, "") === false) : false) : false) : false)));
        if (((or$27value$27293 = $B["equal?"](kind$27291, "film")), (or$27value$27293 ? or$27value$27293 : $B["equal?"](kind$27291, "episode")))) {
          return false;
        } else {
          return $B["map-of"]("playing", true, "paused", paused$27292, "music", true, "title", ((x$27i167 = $B["map-ref"](item$27290, "title", "")), ($B["string?"](x$27i167) ? x$27i167 : ($B["number?"](x$27i167) ? $B["number->string"](x$27i167) : ""))), "label", ((x$27i168 = $B["map-ref"](item$27290, "artist", "")), ($B["string?"](x$27i168) ? x$27i168 : ($B["number?"](x$27i168) ? $B["number->string"](x$27i168) : ""))), "poster", ((x$27i169 = $B["map-ref"](item$27290, "art", "")), ($B["string?"](x$27i169) ? x$27i169 : ($B["number?"](x$27i169) ? $B["number->string"](x$27i169) : ""))), "next", 1, "subtitles", 0, "duration", ((x$27i170 = $B["map-ref"](item$27290, "duration", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i170)))), "position", ((x$27i171 = (real_of$27said($B["map-ref"](q$27289, "position", 0)) + (paused$27292 ? 0.0 : ((now_ms$27page() - real_of$27said($B["map-ref"](q$27289, "received", 0))) / 1000.0)))), $B["exact"]($B["floor"](real_of$27said(x$27i171)))), "queue", $B["map-ref"](q$27289, "id", 0));
        }
      } else {
        return false;
      }
    });
    (others$27277 = function () {
      return other_screens$27where();
    });
    (playing$3f$27278 = function (id) {
      let or$27value$27295, s$27294, x$27i172;
      (s$27294 = ((or$27value$27295 = from_queue$27276(screen_of$27where(id))), ((or$27value$27295) !== false ? or$27value$27295 : $B["map-ref"](states$27269, id, false))));
      if ((s$27294) !== false) {
        (x$27i172 = $B["map-ref"](s$27294, "playing", false));
        if ((x$27i172) !== false) {
          if (((x$27i172 === $sym("null")) === false)) {
            if (($B["equal?"](x$27i172, 0) === false)) {
              return ($B["equal?"](x$27i172, "") === false);
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
    (find_playing$27279 = function (l) {
      for (;;) {
        if ($B["null?"](l)) {
          return false;
        } else {
          if (playing$3f$27278($B["map-ref"]($B["car"](l), "id", ""))) {
            return $B["car"](l);
          } else {
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      }
    });
    (has$3f$27280 = function (l, id) {
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
    (names_of$27281 = function (l) {
      if ($B["null?"](l)) {
        return "";
      } else {
        return $B["string-append"]($B["map-ref"]($B["car"](l), "id", ""), "\n", $B["map-ref"]($B["car"](l), "name", ""), "\n", names_of$27281($B["cdr"](l)));
      }
    });
    (tab$21$27282 = function (t) {
      let b$27296;
      (b$27296 = make_element$27dom("button"));
      set_attribute$21$27dom(b$27296, "type", "button");
      set_attribute$21$27dom(b$27296, "role", "tab");
      set_attribute$21$27dom(b$27296, "data-screen", $B["map-ref"](t, "id", ""));
      set_text$21$27dom(b$27296, $B["map-ref"](t, "name", ""));
      return append$21$27dom(tabs$27271, b$27296);
    });
    (render$27283 = function () {
      let buttons$27302, duration$27314, each$27301, each$27303, list$27297, now$27300, or$27value$27298, or$27value$27307, or$27value$27308, or$27value$27309, or$27value$27310, or$27value$27311, or$27value$27317, playing$27299, playing$27306, position$27315, poster$27312, q$27316, s$27305, src$27313, subtitles$27318, x$27i173, x$27i174, x$27i175, x$27i176, x$27i177, x$27i178, x$27i179, x$27i180, x$27i181, x$27i182;
      (list$27297 = others$27277());
      hide$21$27remote("remote-ready", ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") === false));
      hide$21$27remote("remote-none", ($B["null?"](list$27297) === false));
      (((has$3f$27280(list$27297, chosen$27265)) !== false ? ((or$27value$27298 = picked$27268), (or$27value$27298 ? or$27value$27298 : playing$3f$27278(chosen$27265))) : false) ? false : ((playing$27299 = find_playing$27279(list$27297)), (chosen$27265 = $theString(((playing$27299) !== false ? $B["map-ref"](playing$27299, "id", "") : ((has$3f$27280(list$27297, chosen$27265)) !== false ? chosen$27265 : ($B["null?"](list$27297) ? "" : $B["map-ref"]($B["car"](list$27297), "id", ""))))))));
      ((now$27300 = names_of$27281(list$27297)), ($B["equal?"](now$27300, names$27267) ? false : ((names$27267 = now$27300), clear$21$27dom(tabs$27271), ((each$27301 = function (l) {
        for (;;) {
          if ($B["null?"](l)) {
            return false;
          } else {
            tab$21$27282($B["car"](l));
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      }), each$27301(list$27297)))));
      ((buttons$27302 = query_all$27dom("#remote-tabs [data-screen]")), (each$27303 = function (i) {
        let b$27304;
        for (;;) {
          if ((i < $B["vector-length"](buttons$27302))) {
            (b$27304 = $B["vector-ref"](buttons$27302, i));
            set_attribute$21$27dom(b$27304, "aria-selected", ($B["equal?"](data_of$27dom(b$27304, "screen"), chosen$27265) ? "true" : "false"));
            const $t0 = (i + 1);
            i = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27303(0));
      (s$27305 = ((or$27value$27307 = from_queue$27276(screen_of$27where(chosen$27265))), ((or$27value$27307) !== false ? or$27value$27307 : $B["map-ref"](states$27269, chosen$27265, false))));
      (playing$27306 = ((s$27305) !== false ? ((x$27i173 = $B["map-ref"](s$27305, "playing", false)), ((x$27i173) !== false ? (((x$27i173 === $sym("null")) === false) ? (($B["equal?"](x$27i173, 0) === false) ? ($B["equal?"](x$27i173, "") === false) : false) : false) : false)) : false));
      hide$21$27remote("remote-now", (playing$27306 === false));
      hide$21$27remote("remote-idle", ((or$27value$27308 = $B["equal?"](chosen$27265, "")), (or$27value$27308 ? or$27value$27308 : ((or$27value$27309 = playing$27306), (or$27value$27309 ? or$27value$27309 : $B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play"))))));
      hide$21$27remote("remote-idle-ready", ((or$27value$27310 = $B["equal?"](chosen$27265, "")), (or$27value$27310 ? or$27value$27310 : ((or$27value$27311 = playing$27306), (or$27value$27311 ? or$27value$27311 : ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") === false))))));
      if (playing$27306) {
        (poster$27312 = by_id$27dom("remote-poster"));
        (src$27313 = ((x$27i174 = $B["map-ref"](s$27305, "poster", "")), ($B["string?"](x$27i174) ? x$27i174 : ($B["number?"](x$27i174) ? $B["number->string"](x$27i174) : ""))));
        (duration$27314 = ((x$27i175 = $B["map-ref"](s$27305, "duration", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i175)))));
        (position$27315 = ((x$27i176 = $B["map-ref"](s$27305, "position", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i176)))));
        (q$27316 = queue_of$27275(screen_of$27where(chosen$27265)));
        ((poster$27312) !== false ? (set_hidden$21$27dom(poster$27312, $B["equal?"](src$27313, "")), ((($B["equal?"](src$27313, "") === false) ? ($B["equal?"](attribute_of$27dom(poster$27312, "src"), src$27313) === false) : false) ? set_attribute$21$27dom(poster$27312, "src", src$27313) : false)) : false);
        text$21$27remote("remote-title", ((x$27i177 = $B["map-ref"](s$27305, "title", "")), ($B["string?"](x$27i177) ? x$27i177 : ($B["number?"](x$27i177) ? $B["number->string"](x$27i177) : ""))));
        text$21$27remote("remote-label", ((x$27i178 = $B["map-ref"](s$27305, "label", "")), ($B["string?"](x$27i178) ? x$27i178 : ($B["number?"](x$27i178) ? $B["number->string"](x$27i178) : ""))));
        (dragging$27266 ? false : (set_attribute$21$27dom(seek$27272, "max", $B["number->string"](duration$27314)), set_field$21$27dom(seek$27272, $B["number->string"](position$27315)), text$21$27remote("remote-time", $B["string-append"](clock$27clock((0.0 + position$27315)), " / ", clock$27clock((0.0 + duration$27314))))));
        hide$21$27remote("remote-play", (((x$27i179 = $B["map-ref"](s$27305, "paused", false)), ((x$27i179) !== false ? (((x$27i179 === $sym("null")) === false) ? (($B["equal?"](x$27i179, 0) === false) ? ($B["equal?"](x$27i179, "") === false) : false) : false) : false)) === false));
        hide$21$27remote("remote-pause", ((x$27i180 = $B["map-ref"](s$27305, "paused", false)), ((x$27i180) !== false ? (((x$27i180 === $sym("null")) === false) ? (($B["equal?"](x$27i180, 0) === false) ? ($B["equal?"](x$27i180, "") === false) : false) : false) : false)));
        hide$21$27remote("remote-next-slot", ((q$27316) !== false ? (((or$27value$27317 = ($B["map-ref"](q$27316, "at", 0) < ($B["vector-length"]($B["map-ref"](q$27316, "items", $B["vector"]())) - 1))), (or$27value$27317 ? or$27value$27317 : $B["equal?"]($B["map-ref"](q$27316, "repeat", ""), "all"))) === false) : (((x$27i181 = $B["map-ref"](s$27305, "next", false)), ((x$27i181) !== false ? (((x$27i181 === $sym("null")) === false) ? (($B["equal?"](x$27i181, 0) === false) ? ($B["equal?"](x$27i181, "") === false) : false) : false) : false)) === false)));
        hide$21$27remote("remote-prev-slot", (((q$27316) !== false ? ($B["vector-length"]($B["map-ref"](q$27316, "items", $B["vector"]())) > 0) : false) === false));
        ((subtitles$27318 = query_in$27dom(remote, "[data-command=subtitles]")), ((subtitles$27318) !== false ? set_hidden$21$27dom(subtitles$27318, (((x$27i182 = $B["map-ref"](s$27305, "subtitles", false)), ((x$27i182) !== false ? (((x$27i182 === $sym("null")) === false) ? (($B["equal?"](x$27i182, 0) === false) ? ($B["equal?"](x$27i182, "") === false) : false) : false) : false)) === false)) : false));
        return show_queue$27284(q$27316);
      } else {
        return false;
      }
    });
    (show_queue$27284 = function (q) {
      let at$27321, each$27323, items$27320, list$27319, shape$27322;
      (list$27319 = by_id$27dom("remote-queue"));
      if ((list$27319) !== false) {
        if (((listing$27273 ? q : false) === false)) {
          set_hidden$21$27dom(list$27319, true);
          return (listed$27274 = "");
        } else {
          (items$27320 = $B["map-ref"](q, "items", $B["vector"]()));
          (at$27321 = $B["map-ref"](q, "at", 0));
          (shape$27322 = queue_shape$27285(items$27320, at$27321));
          set_hidden$21$27dom(list$27319, false);
          if ($B["equal?"](shape$27322, listed$27274)) {
            return false;
          } else {
            (listed$27274 = shape$27322);
            clear$21$27dom(list$27319);
            (each$27323 = function (i) {
              for (;;) {
                if ((i < $B["vector-length"](items$27320))) {
                  append$21$27dom(list$27319, queue_row$27286($B["vector-ref"](items$27320, i), (i === at$27321)));
                  const $t0 = (i + 1);
                  i = $t0;
                  continue;
                } else {
                  return false;
                }
              }
            });
            return each$27323(0);
          }
        }
      } else {
        return false;
      }
    });
    (queue_shape$27285 = function (items, at) {
      let each$27324;
      (each$27324 = function (i, out) {
        let x$27i183;
        for (;;) {
          if ((i < $B["vector-length"](items))) {
            const $t0 = (i + 1);
            const $t1 = $B["string-append"](out, ";", $B["number->string"](((x$27i183 = $B["map-ref"]($B["vector-ref"](items, i), "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i183))))));
            i = $t0;
            out = $t1;
            continue;
          } else {
            return out;
          }
        }
      });
      return each$27324(0, $B["number->string"](at));
    });
    (queue_row$27286 = function (item, playing) {
      let artist$27327, b$27326, li$27325, x$27i184, x$27i185, x$27i186;
      (li$27325 = make_element$27dom("li"));
      (b$27326 = make_element$27dom("button"));
      set_attribute$21$27dom(b$27326, "type", "button");
      set_attribute$21$27dom(b$27326, "data-item", $B["number->string"](((x$27i184 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i184))))));
      set_attribute$21$27dom(b$27326, "class", (playing ? "remote-row playing" : "remote-row"));
      set_text$21$27dom(b$27326, ((artist$27327 = ((x$27i185 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i185) ? x$27i185 : ($B["number?"](x$27i185) ? $B["number->string"](x$27i185) : "")))), $B["string-append"](((x$27i186 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i186) ? x$27i186 : ($B["number?"](x$27i186) ? $B["number->string"](x$27i186) : ""))), ($B["equal?"](artist$27327, "") ? "" : $B["string-append"](" \xc2\xb7 ", artist$27327)))));
      append$21$27dom(li$27325, b$27326);
      return li$27325;
    });
    (command$27287 = function (name, value) {
      let msg$27i187, msg$27i188, op$27329, position$27330, q$27328;
      if ($B["equal?"](chosen$27265, "")) {
        return false;
      } else {
        (q$27328 = from_queue$27276(screen_of$27where(chosen$27265)));
        (op$27329 = $B["map-ref"](as_queue$27remote, name, false));
        if ((((q$27328) !== false ? op$27329 : false)) !== false) {
          (position$27330 = $B["map-ref"](q$27328, "position", 0));
          (msg$27i187 = $B["map-of"]("type", "queue", "op", op$27329, "queue", $B["map-ref"](q$27328, "queue", 0), "value", ($B["equal?"](name, "back") ? ((position$27330 > 10) ? (position$27330 - 10) : 0) : ($B["equal?"](name, "forward") ? (position$27330 + 30) : value))));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i187));
          } else {
            return false;
          }
        } else {
          (msg$27i188 = $B["map-of"]("type", "control", "target", chosen$27265, "command", name, "value", value));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i188));
          } else {
            return false;
          }
        }
      }
    });
    (seek_value$27288 = function () {
      let n$27331;
      (n$27331 = $B["string->number"](value_of$27dom(seek$27272)));
      if ((n$27331) !== false) {
        return n$27331;
      } else {
        return 0;
      }
    });
    ((handler$27i189 = function (text, m) {
      (queues$27270 = $B["map-set"](queues$27270, $B["map-ref"](m, "id", 0), $B["map-set"](m, "received", now_ms$27page())));
      return render$27283();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue", $B["append"]($B["map-ref"](handlers$27socket, "queue", null), $listFromEnd(handler$27i189)))));
    ((handler$27i192 = function (text, m) {
      let each$27333, l$27332;
      ((l$27332 = $B["map-ref"](m, "targets", $B["vector"]())), (each$27333 = function (i) {
        let msg$27i191, q$27334, x$27i190;
        for (;;) {
          if ((i < $B["vector-length"](l$27332))) {
            (q$27334 = ((x$27i190 = $B["map-ref"]($B["vector-ref"](l$27332, i), "queue", 0)), $B["exact"]($B["floor"](real_of$27said(x$27i190)))));
            (((q$27334 > 0) ? ($B["map-ref"](queues$27270, q$27334, false) === false) : false) ? ((msg$27i191 = $B["map-of"]("type", "queue", "op", "state", "queue", q$27334)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i191)) : false)) : false);
            const $t0 = (i + 1);
            i = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27333(0));
      return render$27283();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "targets", $B["append"]($B["map-ref"](handlers$27socket, "targets", null), $listFromEnd(handler$27i192)))));
    ((handler$27i193 = function (text, m) {
      return render$27283();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i193)))));
    ((handler$27i194 = function (text, s) {
      (states$27269 = $B["map-set"](states$27269, $B["map-ref"](s, "from", ""), s));
      return render$27283();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "state", $B["append"]($B["map-ref"](handlers$27socket, "state", null), $listFromEnd(handler$27i194)))));
    every$27page(1000, function () {
      if ((from_queue$27276(screen_of$27where(chosen$27265))) !== false) {
        return render$27283();
      } else {
        return false;
      }
    });
    on$27dom(tabs$27271, click$27dom, function (e) {
      let b$27335;
      (b$27335 = closest_of$27dom(e, "[data-screen]"));
      if ((b$27335) !== false) {
        (chosen$27265 = data_of$27dom(b$27335, "screen"));
        (picked$27268 = true);
        return render$27283();
      } else {
        return false;
      }
    });
    on$27dom(remote, click$27dom, function (e) {
      let b$27336;
      (b$27336 = closest_of$27dom(e, "[data-command]"));
      if ((b$27336) !== false) {
        return command$27287(data_of$27dom(b$27336, "command"), 0);
      } else {
        return false;
      }
    });
    ((button$27337 = by_id$27dom("remote-list")), ((button$27337) !== false ? on$27dom(button$27337, click$27dom, function (e) {
      (listing$27273 = (listing$27273 === false));
      set_attribute$21$27dom(button$27337, "aria-expanded", (listing$27273 ? "true" : "false"));
      return render$27283();
    }) : false));
    ((list$27338 = by_id$27dom("remote-queue")), ((list$27338) !== false ? on$27dom(list$27338, click$27dom, function (e) {
      let b$27339, msg$27i195, n$27341, q$27340;
      (b$27339 = closest_of$27dom(e, "[data-item]"));
      (q$27340 = queue_of$27275(screen_of$27where(chosen$27265)));
      if ((((b$27339) !== false ? q$27340 : false)) !== false) {
        (msg$27i195 = $B["map-of"]("type", "queue", "op", "jump", "queue", $B["map-ref"](q$27340, "id", 0), "item", ((n$27341 = $B["string->number"](data_of$27dom(b$27339, "item"))), ((n$27341) !== false ? n$27341 : 0))));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i195));
        } else {
          return false;
        }
      } else {
        return false;
      }
    }) : false));
    on$27dom(seek$27272, input$27dom, function (e) {
      (dragging$27266 = true);
      return text$21$27remote("remote-time", $B["string-append"](clock$27clock(real_of$27said(seek_value$27288())), " / ", clock$27clock(real_of$27said($B["map-ref"]($B["map-ref"](states$27269, chosen$27265, $B["map-of"]()), "duration", 0)))));
    });
    on$27dom(seek$27272, change$27dom, function (e) {
      (dragging$27266 = false);
      return command$27287("seek", seek_value$27288());
    });
    return render$27283();
  });
  (bar_player$27bar = false);
  (bar_key$27bar = "hazelflix-bar");
  (bar_wake$21$27bar = function (queue) {
    let r$27i197, r$27i198, r$27i199;
    if ((bar_player$27bar) !== false) {
      (((((r$27i197 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i197))() ? (((r$27i198 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i198))() === queue) : false)) !== false ? false : ((r$27i199 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i199))(queue));
      return true;
    } else {
      return false;
    }
  });
  (nothing$27bar = function () {
    return false;
  });
  (players_start$27bar = function () {
    let bar$27343, close$27dom$27345, film$27i200, film$27i203, handler$27i211, on_load$27i201, on_load$27i204, on_sleep$27i206, on_wake$27i205, player$27344, screen$27342;
    (screen$27342 = by_id$27dom("player-screen"));
    (bar$27343 = by_id$27dom("music-bar"));
    if ((screen$27342) !== false) {
      return start_player$27player(screen$27342, ((film$27i200 = function (item) {
        return false;
      }), (on_load$27i201 = function (item, p) {
        return false;
      }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", false, false, film$27i200, on_load$27i201, nothing$27bar, nothing$27bar)));
    } else {
      if ((bar$27343) !== false) {
        (player$27344 = start_player$27player(bar$27343, ((film$27i203 = function (item) {
          return false;
        }), (on_load$27i204 = function (item, p) {
          return false;
        }), (on_wake$27i205 = function () {
          let r$27i202;
          set_hidden$21$27dom(bar$27343, false);
          add_class$21$27dom(body$27dom(), "with-bar");
          ((bar_player$27bar) !== false ? session_set$21$27page(bar_key$27bar, $B["number->string"](((r$27i202 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i202))())) : false);
          return false;
        }), (on_sleep$27i206 = function () {
          set_hidden$21$27dom(bar$27343, true);
          remove_class$21$27dom(body$27dom(), "with-bar");
          session_remove$21$27page(bar_key$27bar);
          return false;
        }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", true, true, film$27i203, on_load$27i204, on_wake$27i205, on_sleep$27i206))));
        (bar_player$27bar = player$27344);
        ((close$27dom$27345 = query_in$27dom(bar$27343, "[data-bar-close]")), ((close$27dom$27345) !== false ? on$27dom(close$27dom$27345, click$27dom, function (e) {
          let r$27i207;
          return ((r$27i207 = player$27344), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r$27i207))();
        }) : false));
        (handler$27i211 = function (text, m) {
          let r$27i209, r$27i210, was$27346, x$27i208;
          (was$27346 = ((x$27i208 = $B["string->number"](session_get$27page(bar_key$27bar))), $B["exact"]($B["floor"](real_of$27said(x$27i208)))));
          if ((((was$27346 > 0) ? (((r$27i209 = player$27344), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i209))() === false) : false)) !== false) {
            return ((r$27i210 = player$27344), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i210))(was$27346);
          } else {
            return false;
          }
        });
        return (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i211))));
      } else {
        return false;
      }
    }
  });
  (digits$3f$27bar = function (s, from) {
    let loop$27347;
    if ((from < $B["string-length"](s))) {
      (loop$27347 = function (i) {
        let b$27348;
        for (;;) {
          if ((i === $B["string-length"](s))) {
            return true;
          } else {
            if (((b$27348 = $B["byte-ref"](s, i)), ((b$27348 >= 48) ? (b$27348 <= 57) : false))) {
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return false;
            }
          }
        }
      });
      return loop$27347(from);
    } else {
      return false;
    }
  });
  (site_path$27bar = function (url) {
    let cut$27350, origin$27page$27349;
    (origin$27page$27349 = origin$27page());
    if (($B["string-prefix?"](origin$27page$27349, url) ? $B["string-prefix?"]("/", $B["substring"](url, $B["string-length"](origin$27page$27349), $B["string-length"](url))) : false)) {
      (cut$27350 = function (p, i) {
        let or$27value$27351;
        for (;;) {
          if ((i === $B["string-length"](p))) {
            if (((i > 1) ? $B["string-suffix?"]("/", p) : false)) {
              return $B["substring"](p, 0, (i - 1));
            } else {
              return p;
            }
          } else {
            if (((or$27value$27351 = ($B["byte-ref"](p, i) === 63)), (or$27value$27351 ? or$27value$27351 : ($B["byte-ref"](p, i) === 35)))) {
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
      return cut$27350($B["substring"](url, $B["string-length"](origin$27page$27349), $B["string-length"](url)), 0);
    } else {
      return false;
    }
  });
  (swappable$3f$27bar = function (url) {
    let or$27value$27353, or$27value$27354, or$27value$27355, or$27value$27356, or$27value$27357, or$27value$27358, or$27value$27359, p$27352;
    (p$27352 = site_path$27bar(url));
    if ((p$27352) !== false) {
      (or$27value$27353 = $B["equal?"](p$27352, "/music"));
      if (or$27value$27353) {
        return or$27value$27353;
      } else {
        (or$27value$27354 = $B["equal?"](p$27352, "/music/songs"));
        if (or$27value$27354) {
          return or$27value$27354;
        } else {
          (or$27value$27355 = $B["equal?"](p$27352, "/music/videos"));
          if (or$27value$27355) {
            return or$27value$27355;
          } else {
            (or$27value$27356 = $B["equal?"](p$27352, "/music/artists"));
            if (or$27value$27356) {
              return or$27value$27356;
            } else {
              (or$27value$27357 = $B["equal?"](p$27352, "/music/playlists"));
              if (or$27value$27357) {
                return or$27value$27357;
              } else {
                (or$27value$27358 = ($B["string-prefix?"]("/album/", p$27352) ? digits$3f$27bar(p$27352, 7) : false));
                if ((or$27value$27358) !== false) {
                  return or$27value$27358;
                } else {
                  (or$27value$27359 = ($B["string-prefix?"]("/artist/", p$27352) ? digits$3f$27bar(p$27352, 8) : false));
                  if ((or$27value$27359) !== false) {
                    return or$27value$27359;
                  } else {
                    if ($B["string-prefix?"]("/playlist/", p$27352)) {
                      return digits$3f$27bar(p$27352, 10);
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
    let or$27value$27360, or$27value$27361;
    (or$27value$27360 = $B["equal?"](id_of$27dom(e), "music-bar"));
    if (or$27value$27360) {
      return or$27value$27360;
    } else {
      (or$27value$27361 = $B["equal?"](tag_of$27dom(e), "SCRIPT"));
      if (or$27value$27361) {
        return or$27value$27361;
      } else {
        return $B["equal?"](id_of$27dom(e), "intro");
      }
    }
  });
  (go$27bar = function (url, push) {
    return fetch_text$27fetch(url, function (status, text) {
      let bar$27366, coming$27371, doc$27362, each$27370, each$27372, fresh$27364, fresh_body$27363, here$27365, new_style$27368, now$27369, old_style$27367;
      if ((status === 0)) {
        return go$21$27page(url);
      } else {
        (doc$27362 = read_page$27page(text));
        (fresh_body$27363 = body_of$27dom(doc$27362));
        (fresh$27364 = ((fresh_body$27363) !== false ? first_element_of$27dom(fresh_body$27363) : false));
        (here$27365 = first_element_of$27dom(body$27dom()));
        (bar$27366 = by_id$27dom("music-bar"));
        if ((((fresh$27364) !== false ? ((here$27365) !== false ? ((bar$27366) !== false ? query_in$27dom(doc$27362, "main") : false) : false) : false)) !== false) {
          (old_style$27367 = head_style$27page(this_page$27dom()));
          (new_style$27368 = head_style$27page(doc$27362));
          ((((old_style$27367) !== false ? new_style$27368 : false)) !== false ? set_text$21$27dom(old_style$27367, text_of$27dom(new_style$27368)) : false);
          set_page_title$21$27page(page_title$27page(doc$27362));
          ((now$27369 = children_of$27dom(here$27365)), ((each$27370 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](now$27369))) {
                (kept$3f$27bar($B["vector-ref"](now$27369, i)) ? false : remove$21$27dom($B["vector-ref"](now$27369, i)));
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          }), each$27370(0)));
          ((coming$27371 = children_of$27dom(fresh$27364)), ((each$27372 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](coming$27371))) {
                (kept$3f$27bar($B["vector-ref"](coming$27371, i)) ? false : insert_before$21$27dom(here$27365, import$21$27dom($B["vector-ref"](coming$27371, i)), bar$27366));
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          }), each$27372(0)));
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
        let a$27373, r$27i196$27i212, url$27374;
        if (((((bar_player$27bar) !== false ? ((r$27i196$27i212 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i196$27i212))() : false)) !== false ? ((default_prevented$3f$27dom(e) === false) ? plain_click$3f$27dom(e) : false) : false)) {
          (a$27373 = closest_of$27dom(e, "a[href]"));
          if ((a$27373) !== false) {
            (url$27374 = link_address$27page(a$27373));
            if (((($B["equal?"](url$27374, "") === false) ? swappable$3f$27bar(url$27374) : false)) !== false) {
              prevent_default$21$27dom(e);
              return go$27bar(url$27374, true);
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
        let r$27i196$27i213;
        if ((((((bar_player$27bar) !== false ? ((r$27i196$27i213 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i196$27i213))() : false)) !== false ? swappable$3f$27bar(address$27page()) : false)) !== false) {
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
      let t$27376;
      if ($B["null?"](l)) {
        return null;
      } else {
        (t$27376 = $B["car"](l));
        return $B["cons"]($B["cons"]($B["map-ref"](t$27376, "name", ""), function () {
          return send$27music($B["map-set"](msg, "target", $B["map-ref"](t$27376, "id", "")));
        }), choices($B["cdr"](l)));
      }
    });
    return choose$27ui("Play where?", $B["cons"]($B["cons"]("This browser", function () {
      return send$27music(msg);
    }), choices(there)));
  });
  (music_buttons$27music = function () {
    let handler$27i218, handler$27i219;
    on_document$27dom(click$27dom, function (e) {
      let b$27377, msg$27378, n$27375$27i215, n$27375$27i217, s$27i214, s$27i216, there$27379;
      (b$27377 = closest_of$27dom(e, "[data-music]"));
      if ((b$27377) !== false) {
        (msg$27378 = $B["map-of"]("type", "queue", "op", data_of$27dom(b$27377, "music"), "what", data_of$27dom(b$27377, "what"), "id", ((s$27i214 = data_of$27dom(b$27377, "id")), ((n$27375$27i215 = $B["string->number"](s$27i214)), ((n$27375$27i215) !== false ? n$27375$27i215 : 0))), "start", ((s$27i216 = data_of$27dom(b$27377, "start")), ((n$27375$27i217 = $B["string->number"](s$27i216)), ((n$27375$27i217) !== false ? n$27375$27i217 : 0))), "shuffle", $B["equal?"](data_of$27dom(b$27377, "shuffle"), "1"), "next", $B["equal?"](data_of$27dom(b$27377, "next"), "1"), "queue", queue_now$27player));
        (there$27379 = other_screens$27where());
        prevent_default$21$27dom(e);
        if (($B["equal?"](data_of$27dom(b$27377, "music"), "play") ? (($B["null?"](there$27379) === false) ? (dialogs$3f$27dom() ? (by_id$27dom("player-screen") === false) : false) : false) : false)) {
          return ask_where$27music(msg$27378, there$27379);
        } else {
          return send$27music(msg$27378);
        }
      } else {
        return false;
      }
    });
    ((handler$27i218 = function (text, m) {
      let name$27380;
      if ((by_id$27dom("player-screen")) !== false) {
        return false;
      } else {
        if (($B["map-ref"](m, "elsewhere", false)) !== false) {
          return note$27ui(((name$27380 = $B["map-ref"](m, "name", "")), ($B["equal?"](name$27380, "") ? "Playing on the player that's open." : $B["string-append"]("Playing on ", name$27380, "."))));
        } else {
          if (bar_wake$21$27bar($B["map-ref"](m, "queue", 0))) {
            return false;
          } else {
            return go$21$27page($B["string-append"]("/music/player?queue=", $B["number->string"]($B["map-ref"](m, "queue", 0))));
          }
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queued", $B["append"]($B["map-ref"](handlers$27socket, "queued", null), $listFromEnd(handler$27i218)))));
    (handler$27i219 = function (text, m) {
      let n$27381;
      (n$27381 = $B["map-ref"](m, "n", 1));
      return note$27ui(((n$27381 === 1) ? "Added to the queue." : $B["string-append"]($B["number->string"](n$27381), " added to the queue.")));
    });
    return (handlers$27socket = $B["map-set"](handlers$27socket, "added", $B["append"]($B["map-ref"](handlers$27socket, "added", null), $listFromEnd(handler$27i219))));
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
    let chooser$27385, finished$27393, going$27388, handler$27i233, line_for$27390, lines$27386, made$27389, next$27392, queue$27387, send_file$27394, sending$3f$27391, watch$27395;
    (chooser$27385 = by_id$27dom("photo-files"));
    (lines$27386 = by_id$27dom("photo-uploads"));
    (queue$27387 = null);
    (going$27388 = 0);
    (made$27389 = 0);
    (line_for$27390 = function (name) {
      let l$27396;
      (l$27396 = make_element$27dom("div"));
      set_text$21$27dom(l$27396, $B["string-append"](name, ": waiting"));
      append$21$27dom(lines$27386, l$27396);
      return l$27396;
    });
    (sending$3f$27391 = function () {
      let or$27value$27397;
      (or$27value$27397 = (going$27388 > 0));
      if (or$27value$27397) {
        return or$27value$27397;
      } else {
        return $B["pair?"](queue$27387);
      }
    });
    (next$27392 = function () {
      let f$27398;
      for (;;) {
        if (((going$27388 < at_once$27photos) ? $B["pair?"](queue$27387) : false)) {
          (f$27398 = $B["car"](queue$27387));
          (queue$27387 = $theList($B["cdr"](queue$27387)));
          (going$27388 = (going$27388 + 1));
          send_file$27394(f$27398);
          continue;
        } else {
          return false;
        }
      }
    });
    (finished$27393 = function () {
      (going$27388 = (going$27388 - 1));
      return next$27392();
    });
    (send_file$27394 = function (f) {
      let began$27403, failed$27404, from$27405, id$27401, line$27402, name$27399, size$27400;
      (name$27399 = file_name$27fetch(f));
      (size$27400 = file_size$27fetch(f));
      (id$27401 = $B["random-hex"](16));
      (line$27402 = line_for$27390(name$27399));
      (began$27403 = now_ms$27page());
      (failed$27404 = function (why) {
        set_text$21$27dom(line$27402, $B["string-append"](name$27399, ": ", why));
        set_style$21$27dom(line$27402, "color", "#f0b446");
        return finished$27393();
      });
      (from$27405 = function (at, tried) {
        let asked$27407, end$27406, id$27i220, most$27408, name$27i221, size$27i222;
        (end$27406 = (((at + piece$27photos) > size$27400) ? size$27400 : (at + piece$27photos)));
        (asked$27407 = now_ms$27page());
        (most$27408 = 0);
        return post_piece_watched$21$27fetch(((id$27i220 = id$27401), (name$27i221 = name$27399), (size$27i222 = size$27400), $B["string-append"]("/photos/upload?id=", id$27i220, "&name=", encode_component$27page(name$27i221), "&size=", $B["number->string"](size$27i222))), f, at, end$27406, quiet_ms$27photos, function (sent) {
          let bytes$27i223, mb$27384$27i225, ms$27i224;
          ((sent > most$27408) ? (most$27408 = sent) : false);
          return set_text$21$27dom(line$27402, $B["string-append"](name$27399, ": ", $B["number->string"]($B["quotient"]((100 * (at + sent)), size$27400)), "%", ((bytes$27i223 = (at + sent)), (ms$27i224 = (now_ms$27page() - began$27403)), ((ms$27i224 < 500.0) ? "" : ((mb$27384$27i225 = (((bytes$27i223 + 0.0) / 1048576.0) / (ms$27i224 / 1000.0))), $B["string-append"](", ", $realText(($B["round"]((mb$27384$27i225 * 10.0)) / 10.0)), " MB/s"))))));
        }, function (status, body$27dom) {
          let bytes$27i230, m$27382$27i226, m$27382$27i228, mb$27384$27i232, ms$27i231, v$27383$27i227, v$27383$27i229, why$27409;
          post_form$21$27fetch("/photos/log", $B["string-append"]("line=", encode_component$27page($B["string-append"]("page ", $B["substring"](id$27401, 0, 6), " at ", $B["number->string"](at), "-", $B["number->string"](end$27406), " try ", $B["number->string"](tried), ": status ", $B["number->string"](status), " after ", $B["number->string"]($B["exact"]($B["round"]((now_ms$27page() - asked$27407)))), " ms, ", $B["number->string"](most$27408), " bytes seen going, ", (($B["string-length"](body$27dom) > 60) ? $B["substring"](body$27dom, 0, 60) : body$27dom)))));
          if ((((status <= 0) ? (tried < tries$27photos) : false)) !== false) {
            set_text$21$27dom(line$27402, $B["string-append"](name$27399, ": ", ((status === -1) ? $B["string-append"]("the phone wouldn't hand it over (", body$27dom, "), trying again") : "stalled, trying again")));
            return after$27page(2000, function () {
              return from$27405(at, (tried + 1));
            });
          } else {
            if ((status === -1)) {
              return failed$27404($B["string-append"]("the phone wouldn't hand it over (", body$27dom, ")"));
            } else {
              if (((status === 200) === false)) {
                return failed$27404(((why$27409 = ((m$27382$27i226 = $B["json-parse"](body$27dom, false)), ($B["map?"](m$27382$27i226) ? ((v$27383$27i227 = $B["map-ref"](m$27382$27i226, "error", "")), ($B["string?"](v$27383$27i227) ? v$27383$27i227 : "")) : ""))), ($B["equal?"](why$27409, "") ? "couldn't be sent" : why$27409)));
              } else {
                if ((end$27406 < size$27400)) {
                  return from$27405(end$27406, 1);
                } else {
                  if ($B["equal?"](((m$27382$27i228 = $B["json-parse"](body$27dom, false)), ($B["map?"](m$27382$27i228) ? ((v$27383$27i229 = $B["map-ref"](m$27382$27i228, "state", "")), ($B["string?"](v$27383$27i229) ? v$27383$27i229 : "")) : "")), "known")) {
                    set_text$21$27dom(line$27402, $B["string-append"](name$27399, ": already here"));
                    return finished$27393();
                  } else {
                    (made$27389 = (made$27389 + 1));
                    set_text$21$27dom(line$27402, $B["string-append"](name$27399, ": sent", ((bytes$27i230 = size$27400), (ms$27i231 = (now_ms$27page() - began$27403)), ((ms$27i231 < 500.0) ? "" : ((mb$27384$27i232 = (((bytes$27i230 + 0.0) / 1048576.0) / (ms$27i231 / 1000.0))), $B["string-append"](", ", $realText(($B["round"]((mb$27384$27i232 * 10.0)) / 10.0)), " MB/s")))), ", being made ready"));
                    return finished$27393();
                  }
                }
              }
            }
          }
        });
      });
      if ((size$27400 === 0)) {
        return failed$27404("empty");
      } else {
        if ((size$27400 > piece$27photos)) {
          return failed$27404("too large: 64 MB at most");
        } else {
          return from$27405(0, 1);
        }
      }
    });
    if ((chooser$27385 === false)) {
      return false;
    } else {
      (watch$27395 = function (input$27dom) {
        return on$27dom(input$27dom, change$27dom, function (e) {
          (queue$27387 = $B["append"](queue$27387, $B["vector->list"](chosen_files$27fetch(input$27dom))));
          watch$27395(file_input_again$21$27fetch(input$27dom));
          return next$27392();
        });
      });
      watch$27395(chooser$27385);
      ((handler$27i233 = function (text, msg) {
        let or$27value$27410;
        if (((((or$27value$27410 = (made$27389 > 0)), (or$27value$27410 ? or$27value$27410 : query$27dom("[data-photos-making]")))) !== false ? (sending$3f$27391() === false) : false)) {
          return reload$21$27page();
        } else {
          return false;
        }
      }), (handlers$27socket = $B["map-set"](handlers$27socket, "photos", $B["append"]($B["map-ref"](handlers$27socket, "photos", null), $listFromEnd(handler$27i233)))));
      return photo_dialog$27photos();
    }
  });
  (place_pin$27photos = function (place) {
    let pin$27411;
    (pin$27411 = by_id$27dom("photo-dialog-place"));
    if ((pin$27411) !== false) {
      set_attribute$21$27dom(pin$27411, "data-place", place);
      return set_hidden$21$27dom(pin$27411, $B["equal?"](place, ""));
    } else {
      return false;
    }
  });
  (photo_dialog$27photos = function () {
    let cancel$27415, d$27412, delete$27416, pin$27414;
    (d$27412 = by_id$27dom("photo-dialog"));
    if (((d$27412) !== false ? dialogs$3f$27dom() : false)) {
      each_of$27photos($B["vector->list"](query_all$27dom("[data-photo]")), function (card) {
        return on$27dom(card, click$27dom, function (e) {
          let id$27413;
          if (plain_click$3f$27dom(e)) {
            (id$27413 = data_of$27dom(card, "photo"));
            prevent_default$21$27dom(e);
            set_attribute$21$27dom(by_id$27dom("photo-dialog-img"), "src", $B["string-append"]("/photo/", id$27413));
            set_text$21$27dom(by_id$27dom("photo-dialog-date"), data_of$27dom(card, "date"));
            set_field$21$27dom(by_id$27dom("photo-dialog-caption"), data_of$27dom(card, "caption"));
            place_pin$27photos(data_of$27dom(card, "place"));
            set_attribute$21$27dom(by_id$27dom("photo-dialog-form"), "action", $B["string-append"]("/photos/", id$27413));
            return show_modal$21$27dom(d$27412);
          } else {
            return false;
          }
        });
      });
      ((pin$27414 = by_id$27dom("photo-dialog-place")), ((pin$27414) !== false ? (place_pin$27photos(data_of$27dom(pin$27414, "place")), on$27dom(pin$27414, click$27dom, function (e) {
        set_field$21$27dom(by_id$27dom("photo-dialog-caption"), data_of$27dom(pin$27414, "place"));
        return focus$21$27dom(by_id$27dom("photo-dialog-caption"));
      })) : false));
      ((cancel$27415 = query$27dom("[data-photo-cancel]")), (delete$27416 = query$27dom("[data-photo-delete]")), ((cancel$27415) !== false ? on$27dom(cancel$27415, click$27dom, function (e) {
        prevent_default$21$27dom(e);
        return close_dialog$21$27dom(d$27412);
      }) : false), ((delete$27416) !== false ? on$27dom(delete$27416, click$27dom, function (e) {
        if (confirmed$3f$27page("Delete this photo? Its original goes too.")) {
          return false;
        } else {
          return prevent_default$21$27dom(e);
        }
      }) : false));
      return on$27dom(d$27412, click$27dom, function (e) {
        if ((closest_of$27dom(e, "#photo-dialog img, #photo-dialog form")) !== false) {
          return false;
        } else {
          return close_dialog$21$27dom(d$27412);
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
    let saver$27417, wait$27418;
    (saver$27417 = by_id$27dom("saver"));
    (wait$27418 = by_id$27dom("ready-wait"));
    if ((((saver$27417) !== false ? wait$27418 : false)) !== false) {
      return saver_shows$27saver(saver$27417, wait$27418);
    } else {
      return false;
    }
  });
  (saver_shows$27saver = function (saver, wait) {
    let end$27428, front$27421, handler$27i240, handler$27i241, load_photos$27429, next_photo$27424, order$27420, photos$27419, show$27426, showing$27423, start$27427, texts$27425, timer$27422;
    (photos$27419 = $B["vector"]());
    (order$27420 = null);
    (front$27421 = false);
    (timer$27422 = 0);
    (showing$27423 = false);
    (next_photo$27424 = function () {
      let i$27430, p$27431;
      ($B["null?"](order$27420) ? (order$27420 = $B["vector->list"](photos$27419)) : false);
      (i$27430 = $B["exact"]($B["floor"]((random$27page() * $B["length"](order$27420)))));
      (p$27431 = nth$27saver(order$27420, i$27430));
      (order$27420 = without$27saver(order$27420, i$27430));
      return p$27431;
    });
    (texts$27425 = function (p) {
      set_text$21$27dom(by_id$27dom("saver-caption"), $B["map-ref"](p, "caption", ""));
      return set_text$21$27dom(by_id$27dom("saver-date"), $B["map-ref"](p, "date", ""));
    });
    (show$27426 = function (p) {
      let back$27435, begin_moving$27440, coming$27432, from$27438, going$27433, img$27434, scale$27i234, scale$27i237, to$27439, url$27436, x$27i235, x$27i238, y$27i236, y$27i239, zoom_in$27437;
      (coming$27432 = by_id$27dom(($B["equal?"](front$27421, "saver-a") ? "saver-b" : "saver-a")));
      (going$27433 = ((front$27421) !== false ? by_id$27dom(front$27421) : false));
      (img$27434 = query_in$27dom(coming$27432, "img"));
      (back$27435 = query_in$27dom(coming$27432, ".saver-back"));
      (url$27436 = $B["string-append"]("/photo/", $B["number->string"]($B["map-ref"](p, "id", 0))));
      (zoom_in$27437 = (random$27page() < 0.5));
      (from$27438 = ((scale$27i234 = (zoom_in$27437 ? 1.0 : 1.1000000000000001)), (x$27i235 = (-2.0 + ((2.0 - -2.0) * random$27page()))), (y$27i236 = (-2.0 + ((2.0 - -2.0) * random$27page()))), $B["string-append"]("scale(", $realText(scale$27i234), ") translate(", $B["string-append"]($realText(($B["round"]((x$27i235 * 100.0)) / 100.0)), "%"), ", ", $B["string-append"]($realText(($B["round"]((y$27i236 * 100.0)) / 100.0)), "%"), ")")));
      (to$27439 = ((scale$27i237 = (zoom_in$27437 ? 1.1000000000000001 : 1.0)), (x$27i238 = (-2.0 + ((2.0 - -2.0) * random$27page()))), (y$27i239 = (-2.0 + ((2.0 - -2.0) * random$27page()))), $B["string-append"]("scale(", $realText(scale$27i237), ") translate(", $B["string-append"]($realText(($B["round"]((x$27i238 * 100.0)) / 100.0)), "%"), ", ", $B["string-append"]($realText(($B["round"]((y$27i239 * 100.0)) / 100.0)), "%"), ")")));
      (begin_moving$27440 = function () {
        set_style$21$27dom(coming$27432, "transition", "none");
        set_style$21$27dom(coming$27432, "transform", from$27438);
        set_style$21$27dom(coming$27432, "opacity", "0");
        after$27page(50, function () {
          set_style$21$27dom(coming$27432, "transition", "transform 11.5s linear, opacity 1.5s ease");
          set_style$21$27dom(coming$27432, "transform", to$27439);
          set_style$21$27dom(coming$27432, "opacity", "1");
          texts$27425(p);
          if ((going$27433) !== false) {
            return set_style$21$27dom(going$27433, "opacity", "0");
          } else {
            return false;
          }
        });
        (front$27421 = id_of$27dom(coming$27432));
        return (timer$27422 = after$27page(shown_ms$27saver, function () {
          if (showing$27423) {
            return show$27426(next_photo$27424());
          } else {
            return false;
          }
        }));
      });
      on_once$27dom(img$27434, load$27dom, function (e) {
        if (showing$27423) {
          return begin_moving$27440();
        } else {
          return false;
        }
      });
      set_style$21$27dom(back$27435, "background-image", $B["string-append"]("url(", url$27436, ")"));
      return set_attribute$21$27dom(img$27434, "src", url$27436);
    });
    (start$27427 = function () {
      (showing$27423 = true);
      set_text$21$27dom(by_id$27dom("saver-name"), $B["map-ref"](self$27socket, "name", ""));
      set_hidden$21$27dom(saver, false);
      return show$27426(next_photo$27424());
    });
    (end$27428 = function () {
      (showing$27423 = false);
      cancel_timer$21$27page(timer$27422);
      return set_hidden$21$27dom(saver, true);
    });
    (load_photos$27429 = function () {
      return fetch_text$27fetch("/photos.json", function (status, body$27dom) {
        let l$27441;
        (l$27441 = ((status === 200) ? $B["json-parse"](body$27dom, false) : false));
        if ($B["vector?"](l$27441)) {
          (photos$27419 = $theVector(l$27441));
          (order$27420 = null);
          if ((showing$27423 ? ($B["vector-length"](l$27441) === 0) : false)) {
            return end$27428();
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
    });
    load_photos$27429();
    ((handler$27i240 = function (text, m) {
      return load_photos$27429();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "photos", $B["append"]($B["map-ref"](handlers$27socket, "photos", null), $listFromEnd(handler$27i240)))));
    ((handler$27i241 = function (text, m) {
      return set_text$21$27dom(by_id$27dom("saver-name"), $B["map-ref"](self$27socket, "name", ""));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i241)))));
    return every$27page(1000, function () {
      let want$27442;
      (want$27442 = ((hidden$3f$27dom(wait) === false) ? ($B["vector-length"](photos$27419) > 0) : false));
      if ((want$27442 ? (showing$27423 === false) : false)) {
        return start$27427();
      } else {
        if ((showing$27423 ? (want$27442 === false) : false)) {
          return end$27428();
        } else {
          return false;
        }
      }
    });
  });
  (full$3f$27keypad = function (field, pad) {
    let n$27443;
    (n$27443 = $B["string->number"](data_of$27dom(pad, "length")));
    if ((n$27443) !== false) {
      if ((n$27443 > 0)) {
        return ($B["string-length"](value_of$27dom(field)) >= n$27443);
      } else {
        return false;
      }
    } else {
      return false;
    }
  });
  (keypads_work$27keypad = function () {
    let field$27445, pad$27444;
    (pad$27444 = query$27dom("[data-keypad]"));
    (field$27445 = query$27dom("input[data-code]"));
    if ((((pad$27444) !== false ? field$27445 : false)) !== false) {
      on_document$27dom(click$27dom, function (e) {
        let k$27447, key$27446, now$27448;
        (key$27446 = closest_of$27dom(e, "[data-key]"));
        if ((key$27446) !== false) {
          (k$27447 = data_of$27dom(key$27446, "key"));
          (now$27448 = value_of$27dom(field$27445));
          prevent_default$21$27dom(e);
          ($B["equal?"](k$27447, "back") ? set_field$21$27dom(field$27445, (($B["string-length"](now$27448) > 0) ? $B["substring"](now$27448, 0, ($B["string-length"](now$27448) - 1)) : "")) : (($B["string-length"](now$27448) < 12) ? set_field$21$27dom(field$27445, $B["string-append"](now$27448, k$27447)) : false));
          if (full$3f$27keypad(field$27445, pad$27444)) {
            return submit_form$21$27dom(field$27445);
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
      return on$27dom(field$27445, input$27dom, function (e) {
        if (full$3f$27keypad(field$27445, pad$27444)) {
          return submit_form$21$27dom(field$27445);
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
    let loop$27449;
    (loop$27449 = function (i) {
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
    return loop$27449(0);
  });
  (time_text$27picker = function (t) {
    let hours$27451, minutes$27452, n$27i242, n$27i243, n$27i244, s$27450, seconds$27453;
    const $c1 = $B["floor"](t);
    if (!Number.isInteger($c1)) throw $notInteger;
    (s$27450 = $c1);
    (hours$27451 = $B["quotient"](s$27450, 3600));
    (minutes$27452 = $B["quotient"]($B["remainder"](s$27450, 3600), 60));
    (seconds$27453 = $B["remainder"](s$27450, 60));
    if ((hours$27451 > 0)) {
      return $B["string-append"]($B["number->string"](hours$27451), ":", ((n$27i242 = minutes$27452), ((n$27i242 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i242)) : $B["number->string"](n$27i242))), ":", ((n$27i243 = seconds$27453), ((n$27i243 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i243)) : $B["number->string"](n$27i243))));
    } else {
      return $B["string-append"]($B["number->string"](minutes$27452), ":", ((n$27i244 = seconds$27453), ((n$27i244 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i244)) : $B["number->string"](n$27i244))));
    }
  });
  (number_of$27picker = function (text, fallback) {
    let n$27454;
    (n$27454 = $B["string->number"](text));
    if ((n$27454) !== false) {
      return $theReal((n$27454 + 0.0));
    } else {
      return fallback;
    }
  });
  (pickers_work$27picker = function () {
    return each_in$27picker(query_all$27dom("[data-picker]"), picker_work$27picker);
  });
  (picker_work$27picker = function (p) {
    let box$27456, form$27458, frame$27459, handle$27457, stage$27455;
    (stage$27455 = query_in$27dom(p, "[data-p-stage]"));
    (box$27456 = query_in$27dom(p, "[data-p-box]"));
    (handle$27457 = query_in$27dom(p, "[data-p-handle]"));
    (form$27458 = query_in$27dom(p, "[data-p-form]"));
    (frame$27459 = ((query_in$27dom(p, "video")) !== false ? query_in$27dom(p, "video") : query_in$27dom(p, "img[data-p-frame]")));
    if ((((stage$27455) !== false ? ((box$27456) !== false ? ((handle$27457) !== false ? ((frame$27459) !== false ? form$27458 : false) : false) : false) : false)) !== false) {
      return picker_runs$27picker(p, stage$27455, box$27456, handle$27457, frame$27459, form$27458);
    } else {
      return false;
    }
  });
  (picker_runs$27picker = function (p, stage, box, handle, frame, form) {
    let aspect$27473, choose$27488, dragging$27474, draw$27484, duration$27468, fh$27472, file$27467, fit$27485, frame_h$27482, frame_w$27481, from_x$27475, from_y$27476, fw$27471, fx$27469, fy$27470, go_to$27487, has_video$27464, height_for$27483, label$27461, now$27480, picture$27466, play_button$27463, scrub$27460, set_button$27462, show_time$27486, start_w$27479, start_x$27477, start_y$27478, video$27465;
    (scrub$27460 = query_in$27dom(p, "[data-p-scrub]"));
    (label$27461 = query_in$27dom(p, "[data-p-time]"));
    (set_button$27462 = query_in$27dom(p, "[data-p-set]"));
    (play_button$27463 = query_in$27dom(p, "[data-p-play]"));
    (has_video$27464 = ((query_in$27dom(p, "video")) !== false ? true : false));
    (video$27465 = (has_video$27464 ? media_in$27media(p, "video") : false));
    (picture$27466 = query_in$27dom(p, "img[data-p-frame]"));
    (file$27467 = data_of$27dom(p, "file"));
    (duration$27468 = number_of$27picker(data_of$27dom(p, "duration"), 0.0));
    (fx$27469 = 0.0);
    (fy$27470 = 0.0);
    (fw$27471 = 1.0);
    (fh$27472 = 1.0);
    (aspect$27473 = 0.66666666666666663);
    (dragging$27474 = "");
    (from_x$27475 = 0.0);
    (from_y$27476 = 0.0);
    (start_x$27477 = 0.0);
    (start_y$27478 = 0.0);
    (start_w$27479 = 0.0);
    (now$27480 = number_of$27picker(((scrub$27460) !== false ? value_of$27dom(scrub$27460) : "0"), 0.0));
    (frame_w$27481 = function () {
      return $theReal($B["vector-ref"](rect_of$27dom(frame), 2));
    });
    (frame_h$27482 = function () {
      return $theReal($B["vector-ref"](rect_of$27dom(frame), 3));
    });
    (height_for$27483 = function (w) {
      let H$27490, W$27489, or$27value$27491;
      (W$27489 = frame_w$27481());
      (H$27490 = frame_h$27482());
      if (((or$27value$27491 = (W$27489 <= 0.0)), (or$27value$27491 ? or$27value$27491 : (H$27490 <= 0.0)))) {
        return w;
      } else {
        return ((w * W$27489) / (aspect$27473 * H$27490));
      }
    });
    (draw$27484 = function () {
      let H$27493, W$27492;
      (W$27492 = frame_w$27481());
      (H$27493 = frame_h$27482());
      if (((W$27492 > 0.0) ? (H$27493 > 0.0) : false)) {
        set_style$21$27dom(box, "left", $B["string-append"]($realText((fx$27469 * W$27492)), "px"));
        set_style$21$27dom(box, "top", $B["string-append"]($realText((fy$27470 * H$27493)), "px"));
        set_style$21$27dom(box, "width", $B["string-append"]($realText((fw$27471 * W$27492)), "px"));
        set_style$21$27dom(box, "height", $B["string-append"]($realText((fh$27472 * H$27493)), "px"));
        return set_hidden$21$27dom(box, false);
      } else {
        return false;
      }
    });
    (fit$27485 = function () {
      let h1$27495, h2$27497, w1$27494, w2$27496;
      (w1$27494 = 0.90000000000000002);
      (h1$27495 = height_for$27483(w1$27494));
      (w2$27496 = ((h1$27495 > 0.90000000000000002) ? (w1$27494 * (0.90000000000000002 / h1$27495)) : w1$27494));
      (h2$27497 = height_for$27483(w2$27496));
      (fw$27471 = w2$27496);
      (fh$27472 = h2$27497);
      (fx$27469 = ((1.0 - w2$27496) / 2.0));
      (fy$27470 = ((1.0 - h2$27497) / 2.0));
      return draw$27484();
    });
    (show_time$27486 = function (t) {
      (now$27480 = t);
      ((scrub$27460) !== false ? set_field$21$27dom(scrub$27460, $realText(t)) : false);
      if ((label$27461) !== false) {
        return set_text$21$27dom(label$27461, time_text$27picker(t));
      } else {
        return false;
      }
    });
    (go_to$27487 = function (t) {
      let hi$27i245, t2$27498;
      (t2$27498 = ((hi$27i245 = ((duration$27468 > 0.0) ? duration$27468 : t)), ((t < 0.0) ? 0.0 : ((t > hi$27i245) ? hi$27i245 : t))));
      show_time$27486(t2$27498);
      if (has_video$27464) {
        return seek$21$27media(video$27465, t2$27498);
      } else {
        if ((picture$27466) !== false) {
          return set_attribute$21$27dom(picture$27466, "src", $B["string-append"]("/edit/", file$27467, "/frame?t=", $realText(t2$27498)));
        } else {
          return false;
        }
      }
    });
    (choose$27488 = function (radio) {
      (aspect$27473 = number_of$27picker(data_of$27dom(radio, "aspect"), 0.66666666666666663));
      ((set_button$27462) !== false ? set_text$21$27dom(set_button$27462, $B["string-append"]("Set ", data_of$27dom(radio, "label"))) : false);
      return fit$27485();
    });
    each_in$27picker(query_all_in$27dom(p, "input[name=\"which\"]"), function (radio) {
      (checked$3f$27dom(radio) ? choose$27488(radio) : false);
      return on$27dom(radio, change$27dom, function (e) {
        return choose$27488(radio);
      });
    });
    on$27dom(frame, (has_video$27464 ? loadedmetadata$27media : load$27dom), function (e) {
      return fit$27485();
    });
    on_window$27page(resize$27page, function (e) {
      return draw$27484();
    });
    on$27dom(box, pointerdown$27dom, function (e) {
      prevent_default$21$27dom(e);
      capture_pointer$21$27dom(box, e);
      (dragging$27474 = ((closest_of$27dom(e, "[data-p-handle]")) !== false ? "size" : "move"));
      (from_x$27475 = pointer_x$27dom(e));
      (from_y$27476 = pointer_y$27dom(e));
      (start_x$27477 = fx$27469);
      (start_y$27478 = fy$27470);
      return (start_w$27479 = fw$27471);
    });
    on_document$27dom(pointermove$27dom, function (e) {
      let dx$27499, dy$27500, hh$27503, hi$27i247, hi$27i249, hi$27i251, most_w$27501, w$27502, w2$27504, x$27i246, x$27i248, x$27i250;
      if ($B["equal?"](dragging$27474, "")) {
        return false;
      } else {
        (dx$27499 = ((pointer_x$27dom(e) - from_x$27475) / frame_w$27481()));
        (dy$27500 = ((pointer_y$27dom(e) - from_y$27476) / frame_h$27482()));
        ($B["equal?"](dragging$27474, "move") ? ((fx$27469 = ((x$27i246 = (start_x$27477 + dx$27499)), (hi$27i247 = (1.0 - fw$27471)), ((x$27i246 < 0.0) ? 0.0 : ((x$27i246 > hi$27i247) ? hi$27i247 : x$27i246)))), (fy$27470 = ((x$27i248 = (start_y$27478 + dy$27500)), (hi$27i249 = (1.0 - fh$27472)), ((x$27i248 < 0.0) ? 0.0 : ((x$27i248 > hi$27i249) ? hi$27i249 : x$27i248))))) : ((most_w$27501 = (1.0 - fx$27469)), (w$27502 = ((x$27i250 = (start_w$27479 + dx$27499)), (hi$27i251 = most_w$27501), ((x$27i250 < 0.050000000000000003) ? 0.050000000000000003 : ((x$27i250 > hi$27i251) ? hi$27i251 : x$27i250)))), (hh$27503 = height_for$27483(w$27502)), (w2$27504 = (((fy$27470 + hh$27503) > 1.0) ? (w$27502 * ((1.0 - fy$27470) / hh$27503)) : w$27502)), (fw$27471 = w2$27504), (fh$27472 = height_for$27483(w2$27504))));
        return draw$27484();
      }
    });
    on_document$27dom(pointerup$27dom, function (e) {
      return (dragging$27474 = "");
    });
    ((scrub$27460) !== false ? on$27dom(scrub$27460, input$27dom, function (e) {
      if (has_video$27464) {
        return go_to$27487(number_of$27picker(value_of$27dom(scrub$27460), now$27480));
      } else {
        return show_time$27486(number_of$27picker(value_of$27dom(scrub$27460), now$27480));
      }
    }) : false);
    (((scrub$27460) !== false ? (has_video$27464 === false) : false) ? on$27dom(scrub$27460, change$27dom, function (e) {
      return go_to$27487(number_of$27picker(value_of$27dom(scrub$27460), now$27480));
    }) : false);
    each_in$27picker(query_all_in$27dom(p, "[data-p-step]"), function (b) {
      return on$27dom(b, click$27dom, function (e) {
        (has_video$27464 ? pause$21$27media(video$27465) : false);
        ((play_button$27463) !== false ? set_text$21$27dom(play_button$27463, "Play") : false);
        return go_to$27487(((has_video$27464 ? media_time$27media(video$27465) : now$27480) + (frame_step$27picker * number_of$27picker(data_of$27dom(b, "p-step"), 1.0))));
      });
    });
    (((has_video$27464 ? play_button$27463 : false)) !== false ? (on$27dom(play_button$27463, click$27dom, function (e) {
      if (media_paused$3f$27media(video$27465)) {
        play$21$27media(video$27465);
        return set_text$21$27dom(play_button$27463, "Pause");
      } else {
        pause$21$27media(video$27465);
        return set_text$21$27dom(play_button$27463, "Play");
      }
    }), on$27dom(video$27465, timeupdate$27media, function (e) {
      return show_time$27486(media_time$27media(video$27465));
    }), on$27dom(video$27465, loadedmetadata$27media, function (e) {
      return seek$21$27media(video$27465, now$27480);
    })) : false);
    on$27dom(form, submit$27dom, function (e) {
      let t$27505;
      (t$27505 = (has_video$27464 ? media_time$27media(video$27465) : now$27480));
      set_field$21$27dom(query_in$27dom(form, "input[name=\"t\"]"), $realText(t$27505));
      set_field$21$27dom(query_in$27dom(form, "input[name=\"x\"]"), $realText(fx$27469));
      set_field$21$27dom(query_in$27dom(form, "input[name=\"y\"]"), $realText(fy$27470));
      set_field$21$27dom(query_in$27dom(form, "input[name=\"w\"]"), $realText(fw$27471));
      return set_field$21$27dom(query_in$27dom(form, "input[name=\"h\"]"), $realText(fh$27472));
    });
    if ((frame_w$27481() > 0.0)) {
      return fit$27485();
    } else {
      return false;
    }
  });
  (series_views$27series = function () {
    return on_document$27dom(click$27dom, function (e) {
      let b$27506;
      (b$27506 = closest_of$27dom(e, "[data-series-view]"));
      if ((b$27506) !== false) {
        return cookie_set$21$27page("reel-series-view", data_of$27dom(b$27506, "series-view"), 31536000);
      } else {
        return false;
      }
    });
  });
  (outline$27subtitles = "0 0 3px #000,0 0 2px #000,1px 1px 2px #000");
  (subtitle_previews$27subtitles = function () {
    return on_document$27dom(change$27dom, function (e) {
      let chosen$27509, css$27511, cue$27510, preview$27508, select$27507;
      (select$27507 = closest_of$27dom(e, "select[data-cue]"));
      (preview$27508 = by_id$27dom("cue-preview"));
      if ((((select$27507) !== false ? preview$27508 : false)) !== false) {
        (chosen$27509 = query_in$27dom(select$27507, "option:checked"));
        (cue$27510 = data_of$27dom(select$27507, "cue"));
        if ((chosen$27509) !== false) {
          (css$27511 = data_of$27dom(chosen$27509, "css"));
          set_style$21$27dom(preview$27508, cue$27510, css$27511);
          if ($B["equal?"](cue$27510, "background-color")) {
            return set_style$21$27dom(preview$27508, "text-shadow", ($B["equal?"](css$27511, "transparent") ? outline$27subtitles : "none"));
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
  subtitle_previews$27subtitles();
});
