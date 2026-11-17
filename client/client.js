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
$B["exact"] = (x) => Number.isInteger(x) ? x : $trap("not an integer");
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
const $build = { version: "0.3.1930+4bf691fb.dirty", commit: "4bf691fb", branch: "main" };

// the program
$run(() => {
  let add_class$21$27dom, address$27page, after$27page, again$27intro, alert$21$27page, append$21$27dom, as_queue$27remote, ask$27page, ask_where$27music, ask_where$27where, at_once$27photos, attribute_of$27dom, audio_close$21$27audio, audio_context$27audio, audio_now$27audio, audio_resume$21$27audio, audio_running$3f$27audio, back$21$27page, bar_key$27bar, bar_player$27bar, bar_wake$21$27bar, biquad$27audio, body$27dom, body_of$27dom, browser_id$27socket, by_id$27dom, cancel_timer$21$27page, change$27dom, children_of$27dom, chime_notes$27intro, chimes$27intro, choices$27playlist, choose$27ui, chosen_files$27fetch, clear$21$27dom, clear_source$21$27media, click$27dom, clock$27clock, close$27dom, close_dialog$21$27dom, closest_of$27dom, confirmed$3f$27page, connect$21$27audio, connect$27socket, controls$27remote, converting_refreshes$27search, cookie_get$27page, cookie_set$21$27page, copy_content$21$27dom, data_of$27dom, default_prevented$3f$27dom, delay_node$27audio, destination$27audio, dialogs$3f$27dom, digits$3f$27bar, each_of$27intro, each_of$27photos, encode_component$27page, ended$27media, envelope$27intro, every$27page, fetch_text$27fetch, file_input_again$21$27fetch, file_name$27fetch, file_size$27fetch, film_back$27back, film_page$3f$27back, film_plays$27film, filters_apply$27search, first_element_of$27dom, focus$21$27dom, focus_window$21$27page, fullscreen$21$27page, gain_node$27audio, go$21$27page, go$27bar, handlers$27socket, head_style$27page, heard$27socket, hidden$3f$27dom, hide$21$27remote, history_length$27page, id_of$27dom, import$21$27dom, input$27dom, insert_before$21$27dom, intro_plays$27intro, join_names$27player, kept$3f$27bar, key_of$27dom, keydown$27dom, link_address$27page, load$27dom, loadedmetadata$27media, make_element$27dom, make_player$27player, make_player_options$27player, media_by_id$27media, media_duration$27media, media_in$27media, media_paused$3f$27media, media_ready$3f$27media, media_session$21$27media, media_time$27media, mousemove$27dom, music_buttons$27music, muted$3f$27media, new_playlist$27playlist, noise_source$27audio, note$27ui, nothing$27bar, now_ms$27page, nth$27saver, number_of_field$27film, on$27dom, on_document$27dom, on_media_key$27media, on_once$27dom, on_window$27page, open_socket$27socket, open_window$27page, opener_session_get$27page, origin$27page, oscillator$27audio, other_screens$27where, page_title$27page, pagehide$27page, pages_swap$27bar, panner$27audio, param$27audio, part_in$27dom, partials$27intro, path$27page, pause$21$27media, pause$27media, pending$27playlist, photo_dialog$27photos, photos_page$27photos, piece$27photos, place_pin$27photos, plain_click$3f$27dom, play$21$27media, play$27media, play_then$21$27media, play_where$27where, player$3f$27player, player_current$27player, player_link$3f$27where, player_media$27player, player_options$3f$27player, player_options_asleep$27player, player_options_bar$27player, player_options_film$27player, player_options_on_load$27player, player_options_on_sleep$27player, player_options_on_wake$27player, player_playing$3f$27player, player_position$27player, player_queue$27player, player_reload$27player, player_send$27player, player_sleep$27player, player_state$27player, player_wake$27player, players_start$27bar, playlists_add$27playlist, plays$27film, pointerdown$27dom, pop_out$27playlist, popstate$27page, post_form$21$27fetch, post_piece_watched$21$27fetch, prevent_default$21$27dom, previous_of$27dom, push_address$21$27page, query$27dom, query_all$27dom, query_all_in$27dom, query_has$3f$27page, query_in$27dom, query_with$27page, queue_now$27player, quiet_ms$27photos, ramp_to$21$27audio, random$27page, read_page$27page, ready_to_play$27ready, referrer$27page, reload$21$27page, remote_controls$27remote, remove$21$27dom, remove_class$21$27dom, replace_address$21$27page, saver_runs$27saver, screen_of$27where, screen_plays$27ready, scroll_to_top$21$27page, search_as_typed$27search, search_now$27search, seek$21$27media, seeked$27media, self$27socket, send$27music, send_to$27where, sent$27where, session_get$27page, session_remove$21$27page, session_set$21$27page, set_at$21$27audio, set_attribute$21$27dom, set_class$21$27dom, set_field$21$27dom, set_hidden$21$27dom, set_muted$21$27media, set_page_style$21$27dom, set_page_title$21$27page, set_poster$21$27media, set_source$21$27media, set_style$21$27dom, set_text$21$27dom, set_title$21$27dom, set_value$21$27audio, set_volume$21$27media, show_modal$21$27dom, show_subtitles$21$27media, shown_ms$27saver, site_path$27bar, socket_address$27browser$2fsocket, socket_open$27browser$2fsocket, socket_send$21$27browser$2fsocket, sound$27intro, start$21$27audio, start_player$27player, stop$21$27audio, submit$27dom, submit_form$21$27dom, subtitles_showing$3f$27media, swappable$3f$27bar, tab$27socket, tab_id$27socket, tag_of$27dom, targets$27where, text$21$27ready, text$21$27remote, text_of$27dom, this_page$27dom, timeupdate$27media, toggle_class$21$27dom, touchstart$27dom, tries$27photos, user_agent$27page, value_of$27dom, volume$27media, volumechange$27media, wait$27socket, waiting$27where, with_pairs$27player, without$27saver;
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
    let audio$2724, begin_playing$2729, gone$2726, intro$2723, leave$2727, or$27value$2734, show$2730, start$2728, started$2725;
    (intro$2723 = by_id$27dom("intro"));
    (audio$2724 = false);
    (started$2725 = false);
    (gone$2726 = false);
    (leave$2727 = function () {
      let done$2731;
      if ((gone$2726) !== false) {
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
      if ((started$2725) !== false) {
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
        if ((started$2725) !== false) {
          return leave$2727();
        } else {
          return begin_playing$2729();
        }
      });
      on_document$27dom(keydown$27dom, function (e) {
        if ((gone$2726) !== false) {
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
      if ((((or$27value$2734 = by_id$27dom("player")), ((or$27value$2734) !== false ? or$27value$2734 : by_id$27dom("ready")))) !== false) {
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
    let p$2735;
    (p$2735 = param$27audio(g, "gain"));
    set_at$21$27audio(p$2735, 0.0001, 0.0);
    set_at$21$27audio(p$2735, 0.0001, at);
    ramp_to$21$27audio(p$2735, peak, (at + attack));
    set_at$21$27audio(p$2735, peak, (at + (attack + hold)));
    return ramp_to$21$27audio(p$2735, 0.0001, (at + (attack + (hold + release))));
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
    let at$2746, band$2744, echo$2738, feedback$2739, hg$2745, hiss$2743, note$2748, notes$2749, open$2747, out$2737, t0$2736, wet$2740;
    (t0$2736 = (audio_now$27audio(c) + 0.050000000000000003));
    (out$2737 = gain_node$27audio(c));
    (echo$2738 = delay_node$27audio(c, 1.0));
    (feedback$2739 = gain_node$27audio(c));
    (wet$2740 = gain_node$27audio(c));
    set_value$21$27audio(param$27audio(out$2737, "gain"), 0.69999999999999996);
    connect$21$27audio(out$2737, destination$27audio(c));
    set_value$21$27audio(param$27audio(echo$2738, "delayTime"), 0.27000000000000002);
    set_value$21$27audio(param$27audio(feedback$2739, "gain"), 0.32000000000000001);
    set_value$21$27audio(param$27audio(wet$2740, "gain"), 0.28000000000000003);
    connect$21$27audio(echo$2738, feedback$2739);
    connect$21$27audio(feedback$2739, echo$2738);
    connect$21$27audio(echo$2738, wet$2740);
    connect$21$27audio(wet$2740, destination$27audio(c));
    connect$21$27audio(out$2737, echo$2738);
    each_of$27intro(new Pair(49.0, new Pair(49.600000000000001, null)), function (f) {
      let g$2742, o$2741;
      (o$2741 = oscillator$27audio(c, "sine"));
      (g$2742 = gain_node$27audio(c));
      set_at$21$27audio(param$27audio(o$2741, "frequency"), f, t0$2736);
      ramp_to$21$27audio(param$27audio(o$2741, "frequency"), (f * 1.1200000000000001), (t0$2736 + 2.2999999999999998));
      envelope$27intro(g$2742, t0$2736, 1.6000000000000001, 0.32000000000000001, 0.59999999999999998, 1.6000000000000001);
      connect$21$27audio(o$2741, g$2742);
      connect$21$27audio(g$2742, out$2737);
      start$21$27audio(o$2741, t0$2736);
      return stop$21$27audio(o$2741, (t0$2736 + 4.2000000000000002));
    });
    ((hiss$2743 = noise_source$27audio(c, 2.0)), (band$2744 = biquad$27audio(c, "bandpass")), (hg$2745 = gain_node$27audio(c)), set_value$21$27audio(param$27audio(band$2744, "Q"), 6.0), set_at$21$27audio(param$27audio(band$2744, "frequency"), 700.0, (t0$2736 + 1.1000000000000001)), ramp_to$21$27audio(param$27audio(band$2744, "frequency"), 7000.0, (t0$2736 + 2.2999999999999998)), envelope$27intro(hg$2745, (t0$2736 + 1.1000000000000001), 0.69999999999999996, 0.089999999999999997, 0.29999999999999999, 0.5), connect$21$27audio(hiss$2743, band$2744), connect$21$27audio(band$2744, hg$2745), connect$21$27audio(hg$2745, out$2737), start$21$27audio(hiss$2743, (t0$2736 + 1.1000000000000001)), stop$21$27audio(hiss$2743, (t0$2736 + 3.1000000000000001)));
    (at$2746 = (t0$2736 + 2.2999999999999998));
    (open$2747 = biquad$27audio(c, "lowpass"));
    set_at$21$27audio(param$27audio(open$2747, "frequency"), 500.0, at$2746);
    ramp_to$21$27audio(param$27audio(open$2747, "frequency"), 3000.0, (at$2746 + 1.2));
    connect$21$27audio(open$2747, out$2737);
    (note$2748 = function (f, i) {
      return each_of$27intro(new Pair(-6.0, new Pair(6.0, null)), function (cents) {
        let g$2751, o$2750;
        (o$2750 = oscillator$27audio(c, "triangle"));
        (g$2751 = gain_node$27audio(c));
        set_value$21$27audio(param$27audio(o$2750, "frequency"), f);
        set_value$21$27audio(param$27audio(o$2750, "detune"), cents);
        envelope$27intro(g$2751, (at$2746 + (i * 0.02)), 0.40000000000000002, 0.040000000000000001, 0.59999999999999998, 2.3999999999999999);
        connect$21$27audio(o$2750, g$2751);
        connect$21$27audio(g$2751, open$2747);
        start$21$27audio(o$2750, at$2746);
        return stop$21$27audio(o$2750, (at$2746 + 3.6000000000000001));
      });
    });
    (notes$2749 = function (l, i) {
      for (;;) {
        if ($B["null?"](l)) {
          return true;
        } else {
          note$2748($B["car"](l), i);
          const $t0 = $B["cdr"](l);
          const $t1 = (i + 1.0);
          l = $t0;
          i = $t1;
          continue;
        }
      }
    });
    notes$2749(new Pair(110.0, new Pair(164.81, new Pair(220.0, new Pair(277.18000000000001, new Pair(329.63, null))))), 0.0);
    return chimes$27intro(c, out$2737, at$2746);
  });
  (chime_notes$27intro = $B["vector"](880.0, 987.76999999999998, 1108.73, 1318.51, 1479.98, 1760.0, 1975.53, 2217.46));
  (partials$27intro = new Pair(new Pair(1.0, new Pair(1.0, new Pair(3.2000000000000002, null))), new Pair(new Pair(2.7599999999999998, new Pair(0.41999999999999998, new Pair(1.8999999999999999, null))), new Pair(new Pair(5.4000000000000004, new Pair(0.20000000000000001, new Pair(1.1000000000000001, null))), new Pair(new Pair(8.9299999999999997, new Pair(0.089999999999999997, new Pair(0.59999999999999998, null))), null)))));
  (chimes$27intro = function (c, out, at) {
    let strike;
    (strike = function (i, when, gap, last) {
      let first$2752, n$2753, place$2755, strength$2754;
      if ((i < 11)) {
        (first$2752 = $B["exact"]($B["floor"]((random$27page() * 8))));
        (n$2753 = ((first$2752 === last) ? $B["modulo"]((first$2752 + (1 + $B["exact"]($B["floor"]((random$27page() * 3))))), 8) : first$2752));
        (strength$2754 = (0.074999999999999997 * ((1.0 - ($B["inexact"](i) / 14.0)) * (0.69999999999999996 + (random$27page() * 0.5)))));
        (place$2755 = panner$27audio(c));
        ((place$2755) !== false ? (set_value$21$27audio(param$27audio(place$2755, "pan"), ((random$27page() * 1.3999999999999999) - 0.69999999999999996)), connect$21$27audio(place$2755, out)) : false);
        each_of$27intro(partials$27intro, function (p) {
          return each_of$27intro(new Pair(-4.0, new Pair(4.0, null)), function (cents) {
            let g$2757, o$2756, ring$2758;
            (o$2756 = oscillator$27audio(c, "sine"));
            (g$2757 = gain_node$27audio(c));
            (ring$2758 = $B["car"]($B["cdr"]($B["cdr"](p))));
            set_value$21$27audio(param$27audio(o$2756, "frequency"), ($B["vector-ref"](chime_notes$27intro, n$2753) * $B["car"](p)));
            set_value$21$27audio(param$27audio(o$2756, "detune"), (cents + ((random$27page() * 4.0) - 2.0)));
            set_at$21$27audio(param$27audio(g$2757, "gain"), 0.0001, when);
            ramp_to$21$27audio(param$27audio(g$2757, "gain"), (strength$2754 * $B["car"]($B["cdr"](p))), (when + 0.0040000000000000001));
            ramp_to$21$27audio(param$27audio(g$2757, "gain"), 0.0001, (when + ring$2758));
            connect$21$27audio(o$2756, g$2757);
            connect$21$27audio(g$2757, ((place$2755) !== false ? place$2755 : out));
            start$21$27audio(o$2756, when);
            return stop$21$27audio(o$2756, (when + (ring$2758 + 0.050000000000000003)));
          });
        });
        return strike((i + 1), (when + (gap + (random$27page() * gap))), (gap * 1.22), n$2753);
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
    let h$2760, m$2761, n$27i2, n$27i3, t$2759;
    (t$2759 = ((s > 0.0) ? $B["exact"]($B["floor"](s)) : 0));
    (h$2760 = $B["quotient"](t$2759, 3600));
    (m$2761 = $B["quotient"]($B["remainder"](t$2759, 3600), 60));
    return $B["string-append"](((h$2760 > 0) ? $B["string-append"]($B["number->string"](h$2760), ":", ((n$27i2 = m$2761), ((n$27i2 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i2)) : $B["number->string"](n$27i2)))) : $B["number->string"](m$2761)), ":", ((n$27i3 = $B["remainder"](t$2759, 60)), ((n$27i3 < 10) ? $B["string-append"]("0", $B["number->string"](n$27i3)) : $B["number->string"](n$27i3))));
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
    let art$2765, asleep$2777, bar$2778, current$2782, current$27i87, dragging$2774, expected$2783, film_of$2779, handler$27i65, handler$27i66, handler$27i68, handler$27i71, heard$2773, items$2780, labels$21$2785, list_items$2790, listed$2775, live$2776, load$27dom$2786, loaded$2771, media$2764, media$27i92, number_in$2794, offset$2772, play_or_not$2787, playing$3f$27i88, position$2784, position$27i86, queue$27i89, queues$21$2791, received$2770, reload$27i91, render$2788, row$21$2789, seek$2766, select$27141, send$2781, send$27i85, sleep$2793, sleep$27i84, start$2767, state$2769, state$27i90, volume$27media$27157, wake$2792, wake$27i83, wanted$2768, x$27i4;
    (media$2764 = media_in$27media(root, "[data-p=media]"));
    (art$2765 = part_in$27dom(root, $B["string-append"]("[data-p=", "art", "]"), "img"));
    (seek$2766 = part_in$27dom(root, $B["string-append"]("[data-p=", "seek", "]"), "input"));
    (start$2767 = part_in$27dom(root, $B["string-append"]("[data-p=", "start", "]"), "button"));
    (wanted$2768 = ((x$27i4 = $B["string->number"](data_of$27dom(root, "queue"))), $B["exact"]($B["floor"](($B["number?"](x$27i4) ? (x$27i4 + 0.0) : 0.0)))));
    (state$2769 = false);
    (received$2770 = 0.0);
    (loaded$2771 = 0);
    (offset$2772 = 0.0);
    (heard$2773 = false);
    (dragging$2774 = false);
    (listed$2775 = "");
    (live$2776 = false);
    (asleep$2777 = $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 0, options));
    (bar$2778 = $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 1, options));
    ((asleep$2777) !== false ? false : (queue_now$27player = wanted$2768));
    (film_of$2779 = function (item) {
      let kind$2762$27i5, or$27value$2763$27i6;
      if (((kind$2762$27i5 = $B["map-ref"](item, "kind", "")), ((or$27value$2763$27i6 = $B["equal?"](kind$2762$27i5, "film")), (or$27value$2763$27i6 ? or$27value$2763$27i6 : $B["equal?"](kind$2762$27i5, "episode"))))) {
        return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 2, options)(item);
      } else {
        return false;
      }
    });
    (items$2780 = function () {
      if ((state$2769) !== false) {
        return $B["map-ref"](state$2769, "items", $B["vector"]());
      } else {
        return $B["vector"]();
      }
    });
    (send$2781 = function (op, extra) {
      let msg$27i7;
      (msg$27i7 = with_pairs$27player($B["map-of"]("type", "queue", "op", op, "queue", ((state$2769) !== false ? $B["map-ref"](state$2769, "id", 0) : wanted$2768)), extra));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i7));
      } else {
        return false;
      }
    });
    (current$2782 = function () {
      if (($B["vector-length"](items$2780()) > 0)) {
        return $B["vector-ref"](items$2780(), $B["map-ref"](state$2769, "at", 0));
      } else {
        return false;
      }
    });
    (expected$2783 = function () {
      let x$27i8, x$27i9;
      return (((x$27i8 = $B["map-ref"](state$2769, "position", 0)), ($B["number?"](x$27i8) ? (x$27i8 + 0.0) : 0.0)) + (((x$27i9 = $B["map-ref"](state$2769, "paused", false)), ((x$27i9) !== false ? (((x$27i9 === $sym("null")) === false) ? (($B["equal?"](x$27i9, 0) === false) ? ($B["equal?"](x$27i9, "") === false) : false) : false) : false)) ? 0.0 : ((now_ms$27page() - received$2770) / 1000.0)));
    });
    (position$2784 = function () {
      return (offset$2772 + media_time$27media(media$2764));
    });
    (labels$21$2785 = function (item, artist_text, artist_href, album_text, album_href) {
      let album$2796, artist$2795, before$2797, x$27i10;
      set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "title", "]"), "span"), ((x$27i10 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i10) ? x$27i10 : ($B["number?"](x$27i10) ? $B["number->string"](x$27i10) : ""))));
      (artist$2795 = part_in$27dom(root, $B["string-append"]("[data-p=", "artist", "]"), "a"));
      (album$2796 = part_in$27dom(root, $B["string-append"]("[data-p=", "album", "]"), "a"));
      set_text$21$27dom(artist$2795, artist_text);
      set_attribute$21$27dom(artist$2795, "href", artist_href);
      set_text$21$27dom(album$2796, album_text);
      set_attribute$21$27dom(album$2796, "href", album_href);
      (before$2797 = previous_of$27dom(album$2796));
      if ((before$2797) !== false) {
        return set_hidden$21$27dom(before$2797, $B["equal?"](album_text, ""));
      } else {
        return false;
      }
    });
    (load$27dom$2786 = function (item) {
      let at$2799, e$27100, or$27value$27103, or$27value$27104, p$2798, pictured$27102, src$27101, x$27i11, x$27i12, x$27i13, x$27i14, x$27i15, x$27i16, x$27i17, x$27i18, x$27i19, x$27i20, x$27i21, x$27i22, x$27i23, x$27i24, x$27i25, x$27i26, x$27i27, x$27i28, x$27i29, x$27i30;
      (p$2798 = film_of$2779(item));
      (at$2799 = ((e$27100 = ((x$27i11 = expected$2783()), $B["exact"]($B["floor"](($B["number?"](x$27i11) ? (x$27i11 + 0.0) : 0.0))))), ((e$27100 > 0) ? e$27100 : 0)));
      (loaded$2771 = $B["map-ref"](item, "id", 0));
      (heard$2773 = false);
      ((p$2798) !== false ? ((live$2776 = (((x$27i12 = $B["map-ref"](p$2798, "ready", false)), ((x$27i12) !== false ? (((x$27i12 === $sym("null")) === false) ? (($B["equal?"](x$27i12, 0) === false) ? ($B["equal?"](x$27i12, "") === false) : false) : false) : false)) === false)), (offset$2772 = ((live$2776) !== false ? ((x$27i13 = at$2799), ($B["number?"](x$27i13) ? (x$27i13 + 0.0) : 0.0)) : 0.0)), set_source$21$27media(media$2764, ((live$2776) !== false ? $B["string-append"]("/live/", ((x$27i14 = $B["map-ref"](p$2798, "file", 0)), ($B["string?"](x$27i14) ? x$27i14 : ($B["number?"](x$27i14) ? $B["number->string"](x$27i14) : ""))), "?t=", $B["number->string"](at$2799), (((x$27i15 = $B["map-ref"](p$2798, "format", 0)), ((x$27i15) !== false ? (((x$27i15 === $sym("null")) === false) ? (($B["equal?"](x$27i15, 0) === false) ? ($B["equal?"](x$27i15, "") === false) : false) : false) : false)) ? $B["string-append"]("&format=", ((x$27i16 = $B["map-ref"](p$2798, "format", 0)), ($B["string?"](x$27i16) ? x$27i16 : ($B["number?"](x$27i16) ? $B["number->string"](x$27i16) : "")))) : "")) : ((x$27i17 = $B["map-ref"](p$2798, "source", "")), ($B["string?"](x$27i17) ? x$27i17 : ($B["number?"](x$27i17) ? $B["number->string"](x$27i17) : "")))))) : ((src$27101 = ((x$27i18 = $B["map-ref"](item, "src", "")), ($B["string?"](x$27i18) ? x$27i18 : ($B["number?"](x$27i18) ? $B["number->string"](x$27i18) : "")))), (live$2776 = ((x$27i19 = $B["map-ref"](item, "live", false)), ((x$27i19) !== false ? (((x$27i19 === $sym("null")) === false) ? (($B["equal?"](x$27i19, 0) === false) ? ($B["equal?"](x$27i19, "") === false) : false) : false) : false))), (offset$2772 = ((live$2776) !== false ? ((x$27i20 = at$2799), ($B["number?"](x$27i20) ? (x$27i20 + 0.0) : 0.0)) : 0.0)), set_source$21$27media(media$2764, ((live$2776) !== false ? $B["string-append"](src$27101, "?t=", $B["number->string"](at$2799)) : src$27101))));
      (((live$2776 === false) ? (at$2799 > 0) : false) ? on_once$27dom(media$2764, loadedmetadata$27media, function (e) {
        return seek$21$27media(media$2764, expected$2783());
      }) : false);
      ((pictured$27102 = ((or$27value$27103 = ((p$2798) !== false ? true : false)), (or$27value$27103 ? or$27value$27103 : $B["equal?"]($B["map-ref"](item, "kind", ""), "video")))), set_hidden$21$27dom(media$2764, ((or$27value$27104 = (pictured$27102 === false)), (or$27value$27104 ? or$27value$27104 : bar$2778))), set_hidden$21$27dom(art$2765, (pictured$27102 ? (bar$2778 === false) : false)));
      set_attribute$21$27dom(art$2765, "src", ((x$27i21 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i21) ? x$27i21 : ($B["number?"](x$27i21) ? $B["number->string"](x$27i21) : ""))));
      labels$21$2785(item, ((x$27i22 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i22) ? x$27i22 : ($B["number?"](x$27i22) ? $B["number->string"](x$27i22) : ""))), $B["string-append"]("/artist/", ((x$27i23 = $B["map-ref"](item, "artist_id", "")), ($B["string?"](x$27i23) ? x$27i23 : ($B["number?"](x$27i23) ? $B["number->string"](x$27i23) : "")))), ((x$27i24 = $B["map-ref"](item, "album", "")), ($B["string?"](x$27i24) ? x$27i24 : ($B["number?"](x$27i24) ? $B["number->string"](x$27i24) : ""))), (((x$27i25 = $B["map-ref"](item, "album_id", 0)), ((x$27i25) !== false ? (((x$27i25 === $sym("null")) === false) ? (($B["equal?"](x$27i25, 0) === false) ? ($B["equal?"](x$27i25, "") === false) : false) : false) : false)) ? $B["string-append"]("/album/", ((x$27i26 = $B["map-ref"](item, "album_id", 0)), ($B["string?"](x$27i26) ? x$27i26 : ($B["number?"](x$27i26) ? $B["number->string"](x$27i26) : "")))) : "#"));
      media_session$21$27media(((x$27i27 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i27) ? x$27i27 : ($B["number?"](x$27i27) ? $B["number->string"](x$27i27) : ""))), ((x$27i28 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i28) ? x$27i28 : ($B["number?"](x$27i28) ? $B["number->string"](x$27i28) : ""))), ((x$27i29 = $B["map-ref"](item, "album", "")), ($B["string?"](x$27i29) ? x$27i29 : ($B["number?"](x$27i29) ? $B["number->string"](x$27i29) : ""))), ((x$27i30 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i30) ? x$27i30 : ($B["number?"](x$27i30) ? $B["number->string"](x$27i30) : ""))));
      return $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 3, options)(item, p$2798);
    });
    (play_or_not$2787 = function () {
      let x$27i31;
      if (((x$27i31 = $B["map-ref"](state$2769, "paused", false)), ((x$27i31) !== false ? (((x$27i31 === $sym("null")) === false) ? (($B["equal?"](x$27i31, 0) === false) ? ($B["equal?"](x$27i31, "") === false) : false) : false) : false))) {
        return pause$21$27media(media$2764);
      } else {
        return play_then$21$27media(media$2764, function () {
          return set_hidden$21$27dom(start$2767, true);
        }, function () {
          return set_hidden$21$27dom(start$2767, false);
        });
      }
    });
    (render$2788 = function () {
      let how$27114, item$27105, item$27i32, kind$2762$27i33, me$27109, n$27106, names$27110, off$27107, or$27value$2763$27i34, others$27111, players$27108, repeat$27113, shuffle$27112, title$27115, x$27i35, x$27i36, x$27i37, x$27i38, x$27i39, x$27i40, x$27i41, x$27i43, x$27i44, x$27i45, x$27i46;
      (item$27105 = current$2782());
      (n$27106 = $B["vector-length"](items$2780()));
      set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "count", "]"), "span"), ((n$27106 === 0) ? "" : ((n$27106 === 1) ? "1 item" : $B["string-append"]($B["number->string"](n$27106), " items"))));
      ((item$27105 === false) ? ((loaded$2771 = 0), pause$21$27media(media$2764), clear_source$21$27media(media$2764), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "title", "]"), "span"), "Nothing playing")) : ((((item$27i32 = item$27105), ((kind$2762$27i33 = $B["map-ref"](item$27i32, "kind", "")), ((or$27value$2763$27i34 = $B["equal?"](kind$2762$27i33, "film")), (or$27value$2763$27i34 ? or$27value$2763$27i34 : $B["equal?"](kind$2762$27i33, "episode"))))) ? (film_of$2779(item$27105) === false) : false) ? (($B["equal?"]($B["map-ref"](item$27105, "id", 0), loaded$2771) ? false : ((loaded$2771 = $B["map-ref"](item$27105, "id", 0)), pause$21$27media(media$2764), clear_source$21$27media(media$2764), set_hidden$21$27dom(media$2764, true), set_hidden$21$27dom(art$2765, false), set_attribute$21$27dom(art$2765, "src", ((x$27i35 = $B["map-ref"](item$27105, "art", "")), ($B["string?"](x$27i35) ? x$27i35 : ($B["number?"](x$27i35) ? $B["number->string"](x$27i35) : "")))), labels$21$2785(item$27105, ((x$27i36 = $B["map-ref"](item$27105, "label", "")), ($B["string?"](x$27i36) ? x$27i36 : ($B["number?"](x$27i36) ? $B["number->string"](x$27i36) : ""))), ((x$27i37 = $B["map-ref"](item$27105, "src", "")), ($B["string?"](x$27i37) ? x$27i37 : ($B["number?"](x$27i37) ? $B["number->string"](x$27i37) : ""))), "", "#"))), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(expected$2783())), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "length", "]"), "span"), clock$27clock(((x$27i38 = $B["map-ref"](item$27105, "duration", 0)), ($B["number?"](x$27i38) ? (x$27i38 + 0.0) : 0.0)))), ((dragging$2774) !== false ? false : (set_attribute$21$27dom(seek$2766, "max", $B["number->string"](((x$27i39 = $B["map-ref"](item$27105, "duration", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i39) ? (x$27i39 + 0.0) : 0.0)))))), set_field$21$27dom(seek$2766, $B["number->string"](((x$27i40 = expected$2783()), $B["exact"]($B["floor"](($B["number?"](x$27i40) ? (x$27i40 + 0.0) : 0.0))))))))) : (($B["equal?"]($B["map-ref"](item$27105, "id", 0), loaded$2771) === false) ? (load$27dom$2786(item$27105), play_or_not$2787()) : (play_or_not$2787(), ((off$27107 = (position$2784() - expected$2783())), (((((x$27i41 = $B["map-ref"](state$2769, "paused", false)), ((x$27i41) !== false ? (((x$27i41 === $sym("null")) === false) ? (($B["equal?"](x$27i41, 0) === false) ? ($B["equal?"](x$27i41, "") === false) : false) : false) : false)) === false) ? (media_ready$3f$27media(media$2764) ? (((off$27107 < 0.0) ? (0.0 - off$27107) : off$27107) > ((live$2776) !== false ? 3.0 : 1.0)) : false) : false) ? ((live$2776) !== false ? (load$27dom$2786(item$27105), play_or_not$2787()) : seek$21$27media(media$2764, expected$2783())) : false))))));
      ((players$27108 = $B["map-ref"](state$2769, "players", $B["vector"]())), (me$27109 = browser_id$27socket()), (names$27110 = function (i) {
        let x$27i42;
        for (;;) {
          if ((i >= $B["vector-length"](players$27108))) {
            return null;
          } else {
            if ($B["equal?"]($B["map-ref"]($B["vector-ref"](players$27108, i), "id", ""), me$27109)) {
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return $B["cons"](((x$27i42 = $B["map-ref"]($B["vector-ref"](players$27108, i), "name", "")), ($B["string?"](x$27i42) ? x$27i42 : ($B["number?"](x$27i42) ? $B["number->string"](x$27i42) : ""))), names$27110((i + 1)));
            }
          }
        }
      }), ((others$27111 = ($B["vector?"](players$27108) ? names$27110(0) : null)), set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "note", "]"), "span"), ($B["null?"](others$27111) ? "" : $B["string-append"]("Also playing on: ", join_names$27player(others$27111))))));
      set_hidden$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "play", "]"), "button"), (((x$27i43 = $B["map-ref"](state$2769, "paused", false)), ((x$27i43) !== false ? (((x$27i43 === $sym("null")) === false) ? (($B["equal?"](x$27i43, 0) === false) ? ($B["equal?"](x$27i43, "") === false) : false) : false) : false)) === false));
      set_hidden$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "pause", "]"), "button"), ((x$27i44 = $B["map-ref"](state$2769, "paused", false)), ((x$27i44) !== false ? (((x$27i44 === $sym("null")) === false) ? (($B["equal?"](x$27i44, 0) === false) ? ($B["equal?"](x$27i44, "") === false) : false) : false) : false)));
      ((shuffle$27112 = query_in$27dom(root, "[data-player=shuffle]")), (repeat$27113 = query_in$27dom(root, "[data-player=repeat]")), (how$27114 = ((x$27i45 = $B["map-ref"](state$2769, "repeat", "off")), ($B["string?"](x$27i45) ? x$27i45 : ($B["number?"](x$27i45) ? $B["number->string"](x$27i45) : "")))), ((shuffle$27112) !== false ? toggle_class$21$27dom(shuffle$27112, "on", ((x$27i46 = $B["map-ref"](state$2769, "shuffle", false)), ((x$27i46) !== false ? (((x$27i46 === $sym("null")) === false) ? (($B["equal?"](x$27i46, 0) === false) ? ($B["equal?"](x$27i46, "") === false) : false) : false) : false))) : false), ((repeat$27113) !== false ? ((title$27115 = $B["string-append"]("Repeat: ", ($B["equal?"](how$27114, "one") ? "this one" : how$27114))), toggle_class$21$27dom(repeat$27113, "on", ($B["equal?"](how$27114, "off") === false)), set_title$21$27dom(repeat$27113, title$27115), set_attribute$21$27dom(repeat$27113, "aria-label", title$27115)) : false));
      return list_items$2790();
    });
    (row$21$2789 = function (box, item, i) {
      let a$27128, act$21$27123, acts$27120, art$27121, kind$27122, n$27126, pic$27127, row$27116, sub$27119, tile$27125, title$27118, words$27117, x$27i47, x$27i48, x$27i49, x$27i50, x$27i51, x$27i52, x$27i53, x$27i54;
      (row$27116 = make_element$27dom("div"));
      (words$27117 = make_element$27dom("div"));
      (title$27118 = make_element$27dom("div"));
      (sub$27119 = make_element$27dom("div"));
      (acts$27120 = make_element$27dom("div"));
      (art$27121 = ((x$27i47 = $B["map-ref"](item, "art", "")), ($B["string?"](x$27i47) ? x$27i47 : ($B["number?"](x$27i47) ? $B["number->string"](x$27i47) : ""))));
      (kind$27122 = $B["map-ref"](item, "kind", ""));
      (act$21$27123 = function (name, mark, label) {
        let b$27124;
        (b$27124 = make_element$27dom("button"));
        set_attribute$21$27dom(b$27124, "type", "button");
        set_attribute$21$27dom(b$27124, "data-act", name);
        set_text$21$27dom(b$27124, mark);
        set_title$21$27dom(b$27124, label);
        set_attribute$21$27dom(b$27124, "aria-label", label);
        return append$21$27dom(acts$27120, b$27124);
      });
      set_class$21$27dom(row$27116, ((i === $B["map-ref"](state$2769, "at", 0)) ? "queue-row now" : "queue-row"));
      set_attribute$21$27dom(row$27116, "data-item", ((x$27i48 = $B["map-ref"](item, "id", 0)), ($B["string?"](x$27i48) ? x$27i48 : ($B["number?"](x$27i48) ? $B["number->string"](x$27i48) : ""))));
      ($B["equal?"](art$27121, "") ? ((tile$27125 = make_element$27dom("div")), (n$27126 = (((x$27i49 = $B["map-ref"](item, "song", 0)), ((x$27i49) !== false ? (((x$27i49 === $sym("null")) === false) ? (($B["equal?"](x$27i49, 0) === false) ? ($B["equal?"](x$27i49, "") === false) : false) : false) : false)) ? ((x$27i50 = $B["map-ref"](item, "song", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i50) ? (x$27i50 + 0.0) : 0.0)))) : ((x$27i51 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i51) ? (x$27i51 + 0.0) : 0.0)))))), set_class$21$27dom(tile$27125, "queue-tile"), set_style$21$27dom(tile$27125, "background", $B["string-append"]("hsl(", $B["number->string"]($B["modulo"]((n$27126 * 47), 360)), ", 38%, 30%)")), append$21$27dom(row$27116, tile$27125)) : ((pic$27127 = make_element$27dom("img")), set_attribute$21$27dom(pic$27127, "src", art$27121), set_attribute$21$27dom(pic$27127, "alt", ""), set_attribute$21$27dom(pic$27127, "loading", "lazy"), append$21$27dom(row$27116, pic$27127)));
      set_style$21$27dom(words$27117, "min-width", "0");
      set_class$21$27dom(title$27118, "queue-title");
      set_text$21$27dom(title$27118, $B["string-append"](((x$27i52 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i52) ? x$27i52 : ($B["number?"](x$27i52) ? $B["number->string"](x$27i52) : ""))), ($B["equal?"](kind$27122, "video") ? "  (video)" : ($B["equal?"](kind$27122, "film") ? "  (film)" : ""))));
      set_class$21$27dom(sub$27119, "queue-sub");
      set_text$21$27dom(sub$27119, $B["string-append"](((a$27128 = ((x$27i53 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i53) ? x$27i53 : ($B["number?"](x$27i53) ? $B["number->string"](x$27i53) : "")))), ($B["equal?"](a$27128, "") ? "" : $B["string-append"](a$27128, " \xc2\xb7 "))), clock$27clock(((x$27i54 = $B["map-ref"](item, "duration", 0)), ($B["number?"](x$27i54) ? (x$27i54 + 0.0) : 0.0)))));
      append$21$27dom(words$27117, title$27118);
      append$21$27dom(words$27117, sub$27119);
      act$21$27123("up", "\xe2\x96\xb2", "Up");
      act$21$27123("down", "\xe2\x96\xbc", "Down");
      act$21$27123("remove", "\xe2\x9c\x95", "Remove");
      append$21$27dom(row$27116, words$27117);
      append$21$27dom(row$27116, acts$27120);
      return append$21$27dom(box, row$27116);
    });
    (list_items$2790 = function () {
      let all$27130, box$27129, each$27135, ids$27131, key$27132, or$27value$27133, p$27134, x$27i56;
      (box$27129 = query_in$27dom(root, "[data-p=items]"));
      (all$27130 = items$2780());
      (ids$27131 = function (i) {
        let x$27i55;
        if ((i >= $B["vector-length"](all$27130))) {
          return "";
        } else {
          return $B["string-append"](",", ((x$27i55 = $B["map-ref"]($B["vector-ref"](all$27130, i), "id", 0)), ($B["string?"](x$27i55) ? x$27i55 : ($B["number?"](x$27i55) ? $B["number->string"](x$27i55) : ""))), ids$27131((i + 1)));
        }
      });
      (key$27132 = $B["string-append"](((x$27i56 = $B["map-ref"](state$2769, "at", 0)), ($B["string?"](x$27i56) ? x$27i56 : ($B["number?"](x$27i56) ? $B["number->string"](x$27i56) : ""))), ":", ids$27131(0)));
      if (((or$27value$27133 = (box$27129 === false)), (or$27value$27133 ? or$27value$27133 : $B["equal?"](key$27132, listed$2775)))) {
        return false;
      } else {
        (listed$2775 = key$27132);
        clear$21$27dom(box$27129);
        if (($B["vector-length"](all$27130) === 0)) {
          (p$27134 = make_element$27dom("p"));
          set_style$21$27dom(p$27134, "color", "var(--muted, #888)");
          set_text$21$27dom(p$27134, "Empty. Play an album, an artist or a song from Music, or add one with +.");
          return append$21$27dom(box$27129, p$27134);
        } else {
          (each$27135 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](all$27130))) {
                row$21$2789(box$27129, $B["vector-ref"](all$27130, i), i);
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          });
          return each$27135(0);
        }
      }
    });
    (queues$21$2791 = function (l) {
      let each$27137, select$27136, x$27i60;
      (select$27136 = query_in$27dom(root, "[data-p=queue]"));
      if ((select$27136) !== false) {
        clear$21$27dom(select$27136);
        ((each$27137 = function (i) {
          let o$27139, q$27138, x$27i57, x$27i58, x$27i59;
          for (;;) {
            if ((i < $B["vector-length"](l))) {
              (q$27138 = $B["vector-ref"](l, i));
              (o$27139 = make_element$27dom("option"));
              set_attribute$21$27dom(o$27139, "value", ((x$27i57 = $B["map-ref"](q$27138, "id", 0)), ($B["string?"](x$27i57) ? x$27i57 : ($B["number?"](x$27i57) ? $B["number->string"](x$27i57) : ""))));
              set_text$21$27dom(o$27139, $B["string-append"](((x$27i58 = $B["map-ref"](q$27138, "name", "")), ($B["string?"](x$27i58) ? x$27i58 : ($B["number?"](x$27i58) ? $B["number->string"](x$27i58) : ""))), " (", ((x$27i59 = $B["map-ref"](q$27138, "n", 0)), ($B["string?"](x$27i59) ? x$27i59 : ($B["number?"](x$27i59) ? $B["number->string"](x$27i59) : ""))), ")"));
              append$21$27dom(select$27136, o$27139);
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return false;
            }
          }
        }), each$27137(0));
        if ((state$2769) !== false) {
          return set_field$21$27dom(select$27136, ((x$27i60 = $B["map-ref"](state$2769, "id", 0)), ($B["string?"](x$27i60) ? x$27i60 : ($B["number?"](x$27i60) ? $B["number->string"](x$27i60) : ""))));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    (wake$2792 = function (queue) {
      let msg$27i61;
      (asleep$2777 = false);
      (wanted$2768 = queue);
      (loaded$2771 = 0);
      (listed$2775 = "");
      $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 4, options)();
      (msg$27i61 = $B["map-of"]("type", "player", "queue", wanted$2768));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i61));
      } else {
        return false;
      }
    });
    (sleep$2793 = function () {
      let msg$27i62;
      (asleep$2777 = true);
      (state$2769 = false);
      (loaded$2771 = 0);
      pause$21$27media(media$2764);
      clear_source$21$27media(media$2764);
      $B["%record-ref"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", 5, options)();
      (msg$27i62 = $B["map-of"]("type", "player", "stop", true));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i62));
      } else {
        return false;
      }
    });
    (number_in$2794 = function (e) {
      let x$27i63;
      (x$27i63 = $B["string->number"](value_of$27dom(e)));
      return $B["exact"]($B["floor"](($B["number?"](x$27i63) ? (x$27i63 + 0.0) : 0.0)));
    });
    ((handler$27i65 = function (text, m) {
      let msg$27i64;
      if ((asleep$2777) !== false) {
        return false;
      } else {
        (msg$27i64 = $B["map-of"]("type", "player", "queue", wanted$2768));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i64));
        } else {
          return false;
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i65)))));
    ((handler$27i66 = function (text, m) {
      return queues$21$2791($B["map-ref"](m, "queues", $B["vector"]()));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queues", $B["append"]($B["map-ref"](handlers$27socket, "queues", null), $listFromEnd(handler$27i66)))));
    ((handler$27i68 = function (text, m) {
      let or$27value$27140, x$27i67;
      if ((((or$27value$27140 = asleep$2777), ((or$27value$27140) !== false ? or$27value$27140 : ((wanted$2768 > 0) ? ($B["equal?"]($B["map-ref"](m, "id", 0), wanted$2768) === false) : false)))) !== false) {
        return false;
      } else {
        (wanted$2768 = ((x$27i67 = $B["map-ref"](m, "id", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i67) ? (x$27i67 + 0.0) : 0.0)))));
        (queue_now$27player = wanted$2768);
        (state$2769 = m);
        (received$2770 = now_ms$27page());
        set_field$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "queue", "]"), "select"), $B["number->string"](wanted$2768));
        ((($B["equal?"](path$27page(), "/music/player") ? (bar$2778 === false) : false)) !== false ? replace_address$21$27page($B["string-append"]("/music/player?", query_with$27page("queue", $B["number->string"](wanted$2768)))) : false);
        return render$2788();
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue", $B["append"]($B["map-ref"](handlers$27socket, "queue", null), $listFromEnd(handler$27i68)))));
    ((handler$27i71 = function (text, m) {
      let msg$27i70, x$27i69;
      if ((asleep$2777) !== false) {
        return false;
      } else {
        (wanted$2768 = ((x$27i69 = $B["map-ref"](m, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i69) ? (x$27i69 + 0.0) : 0.0)))));
        (msg$27i70 = $B["map-of"]("type", "player", "queue", wanted$2768));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i70));
        } else {
          return false;
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue-made", $B["append"]($B["map-ref"](handlers$27socket, "queue-made", null), $listFromEnd(handler$27i71)))));
    ((select$27141 = part_in$27dom(root, $B["string-append"]("[data-p=", "queue", "]"), "select")), on$27dom(select$27141, change$27dom, function (e) {
      let msg$27i72;
      (wanted$2768 = number_in$2794(select$27141));
      (loaded$2771 = 0);
      (msg$27i72 = $B["map-of"]("type", "player", "queue", wanted$2768));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i72));
      } else {
        return false;
      }
    }));
    on$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "new", "]"), "button"), click$27dom, function (e) {
      let msg$27i73, name$27142;
      (name$27142 = ask$27page("The new queue's name", ""));
      if ((name$27142) !== false) {
        (msg$27i73 = $B["map-of"]("type", "queue", "op", "new", "name", name$27142));
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
      let act$27147, all$27148, button$27146, control$27143, find$27150, item$27145, place$27149, row$27144, x$27i74;
      (control$27143 = closest_of$27dom(e, "[data-player]"));
      if ((control$27143) !== false) {
        return send$2781(data_of$27dom(control$27143, "player"), null);
      } else {
        (row$27144 = closest_of$27dom(e, ".queue-row"));
        if ((((row$27144) !== false ? state$2769 : false)) !== false) {
          (item$27145 = ((x$27i74 = $B["string->number"](data_of$27dom(row$27144, "item"))), $B["exact"]($B["floor"](($B["number?"](x$27i74) ? (x$27i74 + 0.0) : 0.0)))));
          (button$27146 = closest_of$27dom(e, "[data-act]"));
          (act$27147 = ((button$27146) !== false ? data_of$27dom(button$27146, "act") : ""));
          (all$27148 = items$2780());
          (place$27149 = ((find$27150 = function (i) {
            for (;;) {
              if ((i >= $B["vector-length"](all$27148))) {
                return -1;
              } else {
                if ($B["equal?"]($B["map-ref"]($B["vector-ref"](all$27148, i), "id", 0), item$27145)) {
                  return i;
                } else {
                  const $t0 = (i + 1);
                  i = $t0;
                  continue;
                }
              }
            }
          }), find$27150(0)));
          if ($B["equal?"](act$27147, "remove")) {
            return send$2781("remove", $listFromEnd($B["cons"]("item", item$27145)));
          } else {
            if (($B["equal?"](act$27147, "up") ? (place$27149 > 0) : false)) {
              return send$2781("move", $listFromEnd($B["cons"]("to", (place$27149 - 1)), $B["cons"]("item", item$27145)));
            } else {
              if (($B["equal?"](act$27147, "down") ? (place$27149 < ($B["vector-length"](all$27148) - 1)) : false)) {
                return send$2781("move", $listFromEnd($B["cons"]("to", (place$27149 + 1)), $B["cons"]("item", item$27145)));
              } else {
                if ($B["equal?"](act$27147, "")) {
                  return send$2781("jump", $listFromEnd($B["cons"]("item", item$27145)));
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
    on$27dom(start$2767, click$27dom, function (e) {
      return play_then$21$27media(media$2764, function () {
        return set_hidden$21$27dom(start$2767, true);
      }, function () {
        return false;
      });
    });
    on$27dom(media$2764, ended$27media, function (e) {
      let item$27151;
      (item$27151 = current$2782());
      if (((item$27151) !== false ? (asleep$2777 === false) : false)) {
        return send$2781("ended", $listFromEnd($B["cons"]("item", $B["map-ref"](item$27151, "id", 0))));
      } else {
        return false;
      }
    });
    on$27dom(media$2764, timeupdate$27media, function (e) {
      let at$27153, d$27156, half$27155, item$27152, length$27154, x$27i75, x$27i76, x$27i77, x$27i78, x$27i79;
      (item$27152 = current$2782());
      if (((item$27152) !== false ? (asleep$2777 === false) : false)) {
        (at$27153 = position$2784());
        (length$27154 = ((d$27156 = ((x$27i75 = $B["map-ref"](item$27152, "duration", 0)), ($B["number?"](x$27i75) ? (x$27i75 + 0.0) : 0.0))), ((d$27156 > 0.0) ? d$27156 : media_duration$27media(media$2764))));
        (half$27155 = (length$27154 / 2.0));
        (((heard$2773 === false) ? (((x$27i76 = $B["map-ref"](item$27152, "song", 0)), ((x$27i76) !== false ? (((x$27i76 === $sym("null")) === false) ? (($B["equal?"](x$27i76, 0) === false) ? ($B["equal?"](x$27i76, "") === false) : false) : false) : false)) ? (at$27153 > ((half$27155 < 240.0) ? half$27155 : 240.0)) : false) : false) ? ((heard$2773 = true), send$2781("heard", $listFromEnd($B["cons"]("song", $B["map-ref"](item$27152, "song", 0))))) : false);
        ((dragging$2774) !== false ? false : (set_attribute$21$27dom(seek$2766, "max", $B["number->string"](((x$27i77 = length$27154), $B["exact"]($B["floor"](($B["number?"](x$27i77) ? (x$27i77 + 0.0) : 0.0)))))), set_field$21$27dom(seek$2766, $B["number->string"](((x$27i78 = at$27153), $B["exact"]($B["floor"](($B["number?"](x$27i78) ? (x$27i78 + 0.0) : 0.0))))))));
        set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(((dragging$2774) !== false ? ((x$27i79 = number_in$2794(seek$2766)), ($B["number?"](x$27i79) ? (x$27i79 + 0.0) : 0.0)) : at$27153)));
        return set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "length", "]"), "span"), clock$27clock(length$27154));
      } else {
        return false;
      }
    });
    on$27dom(seek$2766, input$27dom, function (e) {
      let x$27i80;
      (dragging$2774 = true);
      return set_text$21$27dom(part_in$27dom(root, $B["string-append"]("[data-p=", "at", "]"), "span"), clock$27clock(((x$27i80 = number_in$2794(seek$2766)), ($B["number?"](x$27i80) ? (x$27i80 + 0.0) : 0.0))));
    });
    on$27dom(seek$2766, change$27dom, function (e) {
      (dragging$2774 = false);
      return send$2781("seek", $listFromEnd($B["cons"]("value", number_in$2794(seek$2766))));
    });
    ((volume$27media$27157 = part_in$27dom(root, $B["string-append"]("[data-p=", "volume", "]"), "input")), on$27dom(volume$27media$27157, input$27dom, function (e) {
      let x$27i81;
      return set_volume$21$27media(media$2764, (((x$27i81 = number_in$2794(volume$27media$27157)), ($B["number?"](x$27i81) ? (x$27i81 + 0.0) : 0.0)) / 100.0));
    }));
    on_media_key$27media("play", function () {
      if ((asleep$2777) !== false) {
        return false;
      } else {
        return send$2781("toggle", null);
      }
    });
    on_media_key$27media("pause", function () {
      if ((asleep$2777) !== false) {
        return false;
      } else {
        return send$2781("toggle", null);
      }
    });
    on_media_key$27media("nexttrack", function () {
      if ((asleep$2777) !== false) {
        return false;
      } else {
        return send$2781("next", null);
      }
    });
    on_media_key$27media("previoustrack", function () {
      if ((asleep$2777) !== false) {
        return false;
      } else {
        return send$2781("prev", null);
      }
    });
    every$27page(2000, function () {
      let x$27i82;
      if ((((asleep$2777 === false) ? ((state$2769) !== false ? ((((x$27i82 = $B["map-ref"](state$2769, "paused", false)), ((x$27i82) !== false ? (((x$27i82 === $sym("null")) === false) ? (($B["equal?"](x$27i82, 0) === false) ? ($B["equal?"](x$27i82, "") === false) : false) : false) : false)) === false) ? current$2782() : false) : false) : false)) !== false) {
        return render$2788();
      } else {
        return false;
      }
    });
    (wake$27i83 = wake$2792);
    (sleep$27i84 = sleep$2793);
    (send$27i85 = send$2781);
    (position$27i86 = position$2784);
    (current$27i87 = current$2782);
    (playing$3f$27i88 = function () {
      return (asleep$2777 === false);
    });
    (queue$27i89 = function () {
      return wanted$2768;
    });
    (state$27i90 = function () {
      return state$2769;
    });
    (reload$27i91 = function () {
      (loaded$2771 = 0);
      if (((state$2769) !== false ? (asleep$2777 === false) : false)) {
        return render$2788();
      } else {
        return false;
      }
    });
    (media$27i92 = media$2764);
    return $B["%record-make"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", wake$27i83, sleep$27i84, send$27i85, position$27i86, current$27i87, playing$3f$27i88, queue$27i89, state$27i90, reload$27i91, media$27i92);
  });
  (note$27ui = function (words) {
    let n$27158;
    (n$27158 = make_element$27dom("div"));
    set_class$21$27dom(n$27158, "music-note");
    set_text$21$27dom(n$27158, words);
    append$21$27dom(body$27dom(), n$27158);
    after$27page(2500, function () {
      return remove$21$27dom(n$27158);
    });
    return false;
  });
  (choose$27ui = function (title, choices) {
    let d$27159, each$27162, heading$27160, option$27161;
    (d$27159 = make_element$27dom("dialog"));
    (heading$27160 = make_element$27dom("h2"));
    set_class$21$27dom(d$27159, "reel-where");
    set_text$21$27dom(heading$27160, title);
    append$21$27dom(d$27159, heading$27160);
    (option$27161 = function (label, act, $class) {
      let b$27163;
      (b$27163 = make_element$27dom("button"));
      set_text$21$27dom(b$27163, label);
      ($B["equal?"]($class, "") ? false : set_class$21$27dom(b$27163, $class));
      on$27dom(b$27163, click$27dom, function (e) {
        close_dialog$21$27dom(d$27159);
        return act();
      });
      return append$21$27dom(d$27159, b$27163);
    });
    (each$27162 = function (l) {
      for (;;) {
        if ($B["null?"](l)) {
          return true;
        } else {
          option$27161($B["car"]($B["car"](l)), $B["cdr"]($B["car"](l)), "");
          const $t0 = $B["cdr"](l);
          l = $t0;
          continue;
        }
      }
    });
    each$27162(choices);
    option$27161("Cancel", function () {
      return false;
    }, "reel-cancel");
    on$27dom(d$27159, close$27dom, function (e) {
      return remove$21$27dom(d$27159);
    });
    append$21$27dom(body$27dom(), d$27159);
    return show_modal$21$27dom(d$27159);
  });
  (pending$27playlist = false);
  (choices$27playlist = function (playlists, i, out) {
    let p$27164;
    if ((i < 0)) {
      return out;
    } else {
      (p$27164 = $B["vector-ref"](playlists, i));
      return choices$27playlist(playlists, (i - 1), $B["cons"]($B["cons"]($B["string-append"]($B["map-ref"](p$27164, "name"), $B["string-append"](" (", $B["string-append"]($B["number->string"]($B["map-ref"](p$27164, "n", 0)), ")"))), function () {
        let msg$27i93$27i95, playlist$27i94;
        (playlist$27i94 = $B["map-ref"](p$27164, "id"));
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
    let msg$27i96, name$27166, what$27165;
    (what$27165 = pending$27playlist);
    (name$27166 = ask$27page("The new playlist's name", ""));
    if ((name$27166) !== false) {
      (msg$27i96 = $B["map-of"]("type", "playlist", "op", "new", "name", name$27166, "what", $B["map-ref"](what$27165, "what"), "id", $B["map-ref"](what$27165, "id")));
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
    let handler$27i98, handler$27i99, save$27169;
    on_document$27dom(click$27dom, function (e) {
      let b$27167, msg$27i97, n$27168;
      (b$27167 = closest_of$27dom(e, "[data-playlist-add]"));
      if ((b$27167) !== false) {
        prevent_default$21$27dom(e);
        (pending$27playlist = $B["map-of"]("what", data_of$27dom(b$27167, "playlist-add"), "id", ((n$27168 = $B["string->number"](data_of$27dom(b$27167, "id"))), ((n$27168) !== false ? n$27168 : 0))));
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
    (save$27169 = by_id$27dom("player-save"));
    if ((save$27169) !== false) {
      return on$27dom(save$27169, click$27dom, function (e) {
        let msg$27i100, name$27170, queue$27171;
        (name$27170 = ask$27page("The playlist's name", ""));
        (queue$27171 = queue_now$27player);
        if (((name$27170) !== false ? (queue$27171 > 0) : false)) {
          (msg$27i100 = $B["map-of"]("type", "playlist", "op", "new", "name", name$27170, "what", "queue", "id", queue$27171));
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
    let buttons$27172, each$27173;
    (query_has$3f$27page("popout") ? ((buttons$27172 = query_all$27dom("[data-popout]")), (each$27173 = function (i) {
      for (;;) {
        if ((i < $B["vector-length"](buttons$27172))) {
          set_hidden$21$27dom($B["vector-ref"](buttons$27172, i), true);
          const $t0 = (i + 1);
          i = $t0;
          continue;
        } else {
          return false;
        }
      }
    }), each$27173(0)) : false);
    return on_document$27dom(click$27dom, function (e) {
      let b$27174, q$27177, queue$27175, w$27176;
      (b$27174 = closest_of$27dom(e, "[data-popout]"));
      if ((b$27174) !== false) {
        (queue$27175 = ((q$27177 = queue_now$27player), ((q$27177 > 0) ? q$27177 : $B["map-ref"](self$27socket, "queue", 0))));
        (w$27176 = open_window$27page($B["string-append"]("/music/player?popout=1", ((queue$27175 > 0) ? $B["string-append"]("&queue=", $B["number->string"](queue$27175)) : "")), "hazelflix-player", "popup,width=460,height=780"));
        prevent_default$21$27dom(e);
        if ((w$27176 === false)) {
          return alert$21$27page("The browser didn't open the window: allow pop-ups for HazelFlix.");
        } else {
          focus_window$21$27page(w$27176);
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
    let video$27179;
    (video$27179 = media_by_id$27media("player"));
    if ((video$27179) !== false) {
      return plays$27film(video$27179);
    } else {
      return false;
    }
  });
  (plays$27film = function (video) {
    let dragging$27195, duration$27183, f$27186, file$27181, film$27180, format$27182, live$27184, n$27178$27i101, n$27178$27i102, n$27178$27i106, offset$27185, position$27187, report$27188, seek$27193, show$27196, start$27191, time$27194;
    (film$27180 = data_of$27dom(video, "film"));
    (file$27181 = data_of$27dom(video, "file"));
    (format$27182 = ((f$27186 = data_of$27dom(video, "format")), ($B["equal?"](f$27186, "") ? "0" : f$27186)));
    (duration$27183 = ((n$27178$27i101 = $B["string->number"](data_of$27dom(video, "duration"))), ((n$27178$27i101) !== false ? (n$27178$27i101 + 0.0) : 0.0)));
    (live$27184 = $B["equal?"](data_of$27dom(video, "live"), "1"));
    (offset$27185 = (live$27184 ? ((n$27178$27i102 = $B["string->number"](data_of$27dom(video, "start"))), ((n$27178$27i102) !== false ? (n$27178$27i102 + 0.0) : 0.0)) : 0.0));
    (position$27187 = function () {
      return (offset$27185 + media_time$27media(video));
    });
    (report$27188 = function (going) {
      let at$27189, length$27190, msg$27i105, x$27i103, x$27i104;
      (at$27189 = ((x$27i103 = position$27187()), ($B["round"]((10.0 * x$27i103)) / 10.0)));
      (length$27190 = ((x$27i104 = ((duration$27183 > 0.0) ? duration$27183 : media_duration$27media(video))), ($B["round"]((10.0 * x$27i104)) / 10.0)));
      if (((going === false) ? ((msg$27i105 = $B["map-of"]("type", "progress", "film", $B["string->number"](film$27180), "file", $B["string->number"](file$27181), "position", at$27189, "duration", length$27190)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i105)) : false)) : false)) {
        return false;
      } else {
        return post_form$21$27fetch("/progress", $B["string-append"]("film=", encode_component$27page(film$27180), "&file=", encode_component$27page(file$27181), "&position=", $B["number->string"](at$27189), "&duration=", $B["number->string"](length$27190)));
      }
    });
    ((live$27184 === false) ? ((start$27191 = ((n$27178$27i106 = $B["string->number"](data_of$27dom(video, "start"))), ((n$27178$27i106) !== false ? (n$27178$27i106 + 0.0) : 0.0))), ((start$27191 > 0.0) ? on_once$27dom(video, loadedmetadata$27media, function (e) {
      return seek$21$27media(video, start$27191);
    }) : false)) : false);
    every$27page(10000, function () {
      if (media_paused$3f$27media(video)) {
        return false;
      } else {
        return report$27188(false);
      }
    });
    on$27dom(video, pause$27media, function (e) {
      return report$27188(false);
    });
    on$27dom(video, ended$27media, function (e) {
      let next$27192;
      report$27188(false);
      (next$27192 = data_of$27dom(video, "next"));
      if ($B["equal?"](next$27192, "")) {
        return false;
      } else {
        return after$27page(1500, function () {
          return go$21$27page(next$27192);
        });
      }
    });
    on_window$27page(pagehide$27page, function (e) {
      return report$27188(true);
    });
    if (live$27184) {
      (seek$27193 = by_id$27dom("live-seek"));
      (time$27194 = by_id$27dom("live-time"));
      (dragging$27195 = false);
      (show$27196 = function (s) {
        if ((time$27194) !== false) {
          return set_text$21$27dom(time$27194, $B["string-append"](clock$27clock(s), " / ", clock$27clock(duration$27183)));
        } else {
          return false;
        }
      });
      on$27dom(video, timeupdate$27media, function (e) {
        (((seek$27193) !== false ? (dragging$27195 === false) : false) ? set_field$21$27dom(seek$27193, $B["number->string"]($B["exact"]($B["floor"](position$27187())))) : false);
        return show$27196(position$27187());
      });
      if ((seek$27193) !== false) {
        on$27dom(seek$27193, input$27dom, function (e) {
          let e$27i107, n$27197$27i108;
          (dragging$27195 = true);
          return show$27196((number_of_field$27film, (e$27i107 = seek$27193), ((n$27197$27i108 = $B["string->number"](value_of$27dom(e$27i107))), ((n$27197$27i108) !== false ? (n$27197$27i108 + 0.0) : 0.0))));
        });
        return on$27dom(seek$27193, change$27dom, function (e) {
          let e$27i109, n$27197$27i110;
          (dragging$27195 = false);
          (offset$27185 = (number_of_field$27film, (e$27i109 = seek$27193), ((n$27197$27i110 = $B["string->number"](value_of$27dom(e$27i109))), ((n$27197$27i110) !== false ? (n$27197$27i110 + 0.0) : 0.0))));
          set_source$21$27media(video, $B["string-append"]("/live/", file$27181, "?t=", $B["number->string"]($B["exact"]($B["floor"](offset$27185))), ($B["equal?"](format$27182, "0") ? "" : $B["string-append"]("&format=", format$27182))));
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
    let n$27197;
    (n$27197 = $B["string->number"](value_of$27dom(e)));
    if ((n$27197) !== false) {
      return (n$27197 + 0.0);
    } else {
      return 0.0;
    }
  });
  (targets$27where = $B["vector"]());
  (waiting$27where = 0);
  (sent$27where = 0);
  (other_screens$27where = function () {
    let from$27199, me$27198;
    (me$27198 = $B["string-append"](browser_id$27socket(), $B["string-append"](".", tab$27socket)));
    (from$27199 = function (i) {
      for (;;) {
        if ((i < 0)) {
          return null;
        } else {
          if ($B["equal?"]($B["map-ref"]($B["vector-ref"](targets$27where, i), "id", ""), me$27198)) {
            const $t0 = (i - 1);
            i = $t0;
            continue;
          } else {
            return $B["cons"]($B["vector-ref"](targets$27where, i), from$27199((i - 1)));
          }
        }
      }
    });
    return $B["reverse"](from$27199(($B["vector-length"](targets$27where) - 1)));
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
    let msg$27i111, this$27200;
    if (((msg$27i111 = $B["map-of"]("type", "play", "target", $B["map-ref"](t, "id", ""), "href", href)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i111)) : false))) {
      (this$27200 = (sent$27where + 1));
      (sent$27where = this$27200);
      (waiting$27where = this$27200);
      return after$27page(5000, function () {
        if ((waiting$27where === this$27200)) {
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
      let t$27201;
      if ($B["null?"](l)) {
        return null;
      } else {
        (t$27201 = $B["car"](l));
        return $B["cons"]($B["cons"]($B["map-ref"](t$27201, "name", ""), function () {
          return send_to$27where(t$27201, href);
        }), choices($B["cdr"](l)));
      }
    });
    return choose$27ui("Play where?", $B["cons"]($B["cons"]("This browser", function () {
      return go$21$27page(href);
    }), choices(there)));
  });
  (player_link$3f$27where = function (href) {
    let digit_at$3f;
    (digit_at$3f = function (s, i) {
      let b$27202;
      if ((i < $B["string-length"](s))) {
        (b$27202 = $B["byte-ref"](s, i));
        if ((b$27202 >= 48)) {
          return (b$27202 <= 57);
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    if ($B["string-prefix?"]("/play/", href)) {
      return digit_at$3f(href, 6);
    } else {
      if ($B["string-prefix?"]("/watch/", href)) {
        return digit_at$3f(href, 7);
      } else {
        return false;
      }
    }
  });
  (play_where$27where = function () {
    let handler$27i112, handler$27i113, handler$27i114;
    ((handler$27i112 = function (text, m) {
      return (targets$27where = $B["map-ref"](m, "targets", $B["vector"]()));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "targets", $B["append"]($B["map-ref"](handlers$27socket, "targets", null), $listFromEnd(handler$27i112)))));
    ((handler$27i113 = function (text, m) {
      if ((waiting$27where > 0)) {
        (waiting$27where = 0);
        return go$21$27page($B["string-append"]("/remote?target=", encode_component$27page($B["map-ref"](m, "target", ""))));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "played", $B["append"]($B["map-ref"](handlers$27socket, "played", null), $listFromEnd(handler$27i113)))));
    ((handler$27i114 = function (text, m) {
      if ((waiting$27where > 0)) {
        (waiting$27where = 0);
        return alert$21$27page($B["map-ref"](m, "why", ""));
      } else {
        return false;
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "failed", $B["append"]($B["map-ref"](handlers$27socket, "failed", null), $listFromEnd(handler$27i114)))));
    return on_document$27dom(click$27dom, function (e) {
      let a$27203, href$27204, there$27205;
      (a$27203 = closest_of$27dom(e, "a[href]"));
      if (((a$27203) !== false ? ((default_prevented$3f$27dom(e) === false) ? (plain_click$3f$27dom(e) ? (by_id$27dom("ready") === false) : false) : false) : false)) {
        (href$27204 = attribute_of$27dom(a$27203, "href"));
        (there$27205 = other_screens$27where());
        if ((player_link$3f$27where(href$27204) ? (($B["null?"](there$27205) === false) ? dialogs$3f$27dom() : false) : false)) {
          prevent_default$21$27dom(e);
          return ask_where$27where(href$27204, there$27205);
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
  });
  (text$21$27ready = function (id, text) {
    let e$27206;
    (e$27206 = by_id$27dom(id));
    if ((e$27206) !== false) {
      return set_text$21$27dom(e$27206, text);
    } else {
      return false;
    }
  });
  (ready_to_play$27ready = function () {
    let ready$27207, video$27208;
    (ready$27207 = by_id$27dom("ready"));
    (video$27208 = media_by_id$27media("screen"));
    if ((((ready$27207) !== false ? video$27208 : false)) !== false) {
      return screen_plays$27ready(video$27208);
    } else {
      return false;
    }
  });
  (screen_plays$27ready = function (video) {
    let card$27212, duration$27220, film$27215, film$27i142, films$27213, handler$27i148, handler$27i155, handler$27i158, handler$27i174, item$27214, loaded$27224, on_load$27i143, on_sleep$27i145, on_wake$27i144, player$27217, reached$27216, report$27222, screen$27211, show_name$27219, start$27209, state$27221, still$27218, stirred$27223, stop$27225, wait$27210;
    (start$27209 = by_id$27dom("ready-start"));
    (wait$27210 = by_id$27dom("ready-wait"));
    (screen$27211 = by_id$27dom("ready-screen"));
    (card$27212 = by_id$27dom("ready-card"));
    (films$27213 = $B["map-of"]());
    (item$27214 = false);
    (film$27215 = false);
    (reached$27216 = 0.0);
    (player$27217 = false);
    (still$27218 = 0);
    (show_name$27219 = function () {
      let name$27226;
      (name$27226 = $B["map-ref"](self$27socket, "name", ""));
      if ($B["equal?"](name$27226, "")) {
        return false;
      } else {
        text$21$27ready("ready-hint-name", $B["string-append"]("\xe2\x80\x9c", name$27226, "\xe2\x80\x9d"));
        return text$21$27ready("ready-name", ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") ? $B["string-append"]("This screen is ", name$27226, ".") : $B["string-append"]("This screen is ", name$27226, ": set it to Play in Settings, Browsers, so others can send to it.")));
      }
    });
    (duration$27220 = function () {
      let x$27i115, x$27i116;
      if ($B["map?"](film$27215)) {
        (x$27i115 = $B["map-ref"](film$27215, "duration", 0));
        if ($B["number?"](x$27i115)) {
          return (x$27i115 + 0.0);
        } else {
          return 0.0;
        }
      } else {
        if ($B["map?"](item$27214)) {
          (x$27i116 = $B["map-ref"](item$27214, "duration", 0));
          if ($B["number?"](x$27i116)) {
            return (x$27i116 + 0.0);
          } else {
            return 0.0;
          }
        } else {
          return 0.0;
        }
      }
    });
    (state$27221 = function () {
      let msg$27i123, r$27i117, x$27i118, x$27i119, x$27i120, x$27i121, x$27i122;
      (msg$27i123 = $B["map-of"]("type", "state", "playing", ($B["map?"](item$27214) ? true : false), "paused", media_paused$3f$27media(video), "position", ((x$27i118 = ((r$27i117 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i117))()), $B["exact"]($B["floor"](($B["number?"](x$27i118) ? (x$27i118 + 0.0) : 0.0)))), "duration", ((x$27i119 = duration$27220()), $B["exact"]($B["floor"](($B["number?"](x$27i119) ? (x$27i119 + 0.0) : 0.0)))), "title", ($B["map?"](item$27214) ? ((x$27i120 = $B["map-ref"](item$27214, "title", "")), ($B["string?"](x$27i120) ? x$27i120 : ($B["number?"](x$27i120) ? $B["number->string"](x$27i120) : ""))) : ""), "label", text_of$27dom(by_id$27dom("ready-label")), "poster", ($B["map?"](film$27215) ? ((x$27i121 = $B["map-ref"](film$27215, "poster", "")), ($B["string?"](x$27i121) ? x$27i121 : ($B["number?"](x$27i121) ? $B["number->string"](x$27i121) : ""))) : ($B["map?"](item$27214) ? ((x$27i122 = $B["map-ref"](item$27214, "art", "")), ($B["string?"](x$27i122) ? x$27i122 : ($B["number?"](x$27i122) ? $B["number->string"](x$27i122) : ""))) : "")), "volume", volume$27media(video), "muted", muted$3f$27media(video), "subtitles", ($B["map?"](film$27215) ? $B["map-ref"](film$27215, "subtitles", 0) : 0), "subtitlesOn", subtitles_showing$3f$27media(video), "next", ($B["map?"](film$27215) ? $B["map-ref"](film$27215, "next", 0) : 0)));
      if ((open_socket$27socket) !== false) {
        return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i123));
      } else {
        return false;
      }
    });
    (report$27222 = function () {
      let msg$27i127, x$27i124, x$27i125, x$27i126;
      if (($B["map?"](film$27215) ? (reached$27216 > 0.0) : false)) {
        (msg$27i127 = $B["map-of"]("type", "progress", "film", $B["map-ref"](film$27215, "film", 0), "file", $B["map-ref"](film$27215, "file", 0), "position", ((x$27i124 = reached$27216), ($B["round"]((10.0 * x$27i124)) / 10.0)), "duration", ((x$27i126 = ((x$27i125 = $B["map-ref"](film$27215, "duration", 0)), ($B["number?"](x$27i125) ? (x$27i125 + 0.0) : 0.0))), ($B["round"]((10.0 * x$27i126)) / 10.0))));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i127));
        } else {
          return false;
        }
      } else {
        return false;
      }
    });
    (stirred$27223 = function () {
      remove_class$21$27dom(screen$27211, "still");
      cancel_timer$21$27page(still$27218);
      return (still$27218 = after$27page(3000, function () {
        return add_class$21$27dom(screen$27211, "still");
      }));
    });
    (loaded$27224 = function (i, p) {
      let album$27228, art$27234, artist$27227, each$27230, each$27231, or$27value$27233, tracks$27229, x$27i128, x$27i129, x$27i130, x$27i131, x$27i134, x$27i135, x$27i136, x$27i137, x$27i138;
      report$27222();
      (item$27214 = i);
      (film$27215 = p);
      (reached$27216 = 0.0);
      text$21$27ready("ready-title", ((x$27i128 = $B["map-ref"](i, "title", "")), ($B["string?"](x$27i128) ? x$27i128 : ($B["number?"](x$27i128) ? $B["number->string"](x$27i128) : ""))));
      text$21$27ready("ready-label", ($B["map?"](p) ? ((x$27i129 = $B["map-ref"](p, "label", "")), ($B["string?"](x$27i129) ? x$27i129 : ($B["number?"](x$27i129) ? $B["number->string"](x$27i129) : ""))) : ((artist$27227 = ((x$27i130 = $B["map-ref"](i, "artist", "")), ($B["string?"](x$27i130) ? x$27i130 : ($B["number?"](x$27i130) ? $B["number->string"](x$27i130) : "")))), (album$27228 = ((x$27i131 = $B["map-ref"](i, "album", "")), ($B["string?"](x$27i131) ? x$27i131 : ($B["number?"](x$27i131) ? $B["number->string"](x$27i131) : "")))), ($B["equal?"](artist$27227, "") ? album$27228 : ($B["equal?"](album$27228, "") ? artist$27227 : $B["string-append"](artist$27227, " \xc2\xb7 ", album$27228))))));
      text$21$27ready("ready-time", "");
      ((tracks$27229 = query_all_in$27dom(video, "track")), ((each$27230 = function (n) {
        for (;;) {
          if ((n < $B["vector-length"](tracks$27229))) {
            remove$21$27dom($B["vector-ref"](tracks$27229, n));
            const $t0 = (n + 1);
            n = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27230(0)));
      ($B["map?"](p) ? ((each$27231 = function (n) {
        let t$27232, x$27i132, x$27i133;
        for (;;) {
          if ((n < ((x$27i132 = $B["map-ref"](p, "subtitles", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i132) ? (x$27i132 + 0.0) : 0.0)))))) {
            (t$27232 = make_element$27dom("track"));
            set_attribute$21$27dom(t$27232, "kind", "subtitles");
            set_attribute$21$27dom(t$27232, "srclang", "en");
            set_attribute$21$27dom(t$27232, "src", $B["string-append"]("/subs/", ((x$27i133 = $B["map-ref"](p, "file", 0)), ($B["string?"](x$27i133) ? x$27i133 : ($B["number?"](x$27i133) ? $B["number->string"](x$27i133) : ""))), "/", $B["number->string"](n)));
            ((n === 0) ? set_attribute$21$27dom(t$27232, "default", "") : false);
            append$21$27dom(video, t$27232);
            const $t0 = (n + 1);
            n = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27231(0)) : false);
      set_poster$21$27media(video, ($B["map?"](p) ? ((x$27i134 = $B["map-ref"](p, "poster", "")), ($B["string?"](x$27i134) ? x$27i134 : ($B["number?"](x$27i134) ? $B["number->string"](x$27i134) : ""))) : ""));
      set_hidden$21$27dom(card$27212, ((or$27value$27233 = $B["map?"](p)), (or$27value$27233 ? or$27value$27233 : $B["equal?"]($B["map-ref"](i, "kind", ""), "video"))));
      text$21$27ready("ready-card-title", ((x$27i135 = $B["map-ref"](i, "title", "")), ($B["string?"](x$27i135) ? x$27i135 : ($B["number?"](x$27i135) ? $B["number->string"](x$27i135) : ""))));
      text$21$27ready("ready-card-artist", ((x$27i136 = $B["map-ref"](i, "artist", "")), ($B["string?"](x$27i136) ? x$27i136 : ($B["number?"](x$27i136) ? $B["number->string"](x$27i136) : ""))));
      text$21$27ready("ready-card-album", ((x$27i137 = $B["map-ref"](i, "album", "")), ($B["string?"](x$27i137) ? x$27i137 : ($B["number?"](x$27i137) ? $B["number->string"](x$27i137) : ""))));
      ((art$27234 = ((x$27i138 = $B["map-ref"](i, "art", "")), ($B["string?"](x$27i138) ? x$27i138 : ($B["number?"](x$27i138) ? $B["number->string"](x$27i138) : "")))), set_style$21$27dom(by_id$27dom("ready-card-back"), "background-image", ($B["equal?"](art$27234, "") ? "none" : $B["string-append"]("url(\"", art$27234, "\")"))));
      stirred$27223();
      return state$27221();
    });
    (stop$27225 = function () {
      let r$27i139, r$27i140, r$27i141;
      if (((r$27i139 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i139))()) {
        ((r$27i140 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i140))("pause", null);
        return ((r$27i141 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r$27i141))();
      } else {
        return false;
      }
    });
    (player$27217 = start_player$27player(screen$27211, ((film$27i142 = function (i) {
      return $B["map-ref"](films$27213, $B["map-ref"](i, "file", 0), false);
    }), (on_load$27i143 = loaded$27224), (on_wake$27i144 = function () {
      set_hidden$21$27dom(start$27209, true);
      set_hidden$21$27dom(wait$27210, true);
      set_hidden$21$27dom(screen$27211, false);
      stirred$27223();
      return false;
    }), (on_sleep$27i145 = function () {
      report$27222();
      (item$27214 = false);
      (film$27215 = false);
      set_hidden$21$27dom(screen$27211, true);
      set_hidden$21$27dom(wait$27210, (hidden$3f$27dom(start$27209) === false));
      state$27221();
      return false;
    }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", true, false, film$27i142, on_load$27i143, on_wake$27i144, on_sleep$27i145))));
    on$27dom(by_id$27dom("ready-go"), click$27dom, function (e) {
      play$21$27media(video);
      pause$21$27media(video);
      fullscreen$21$27page();
      set_hidden$21$27dom(start$27209, true);
      set_hidden$21$27dom(wait$27210, false);
      add_class$21$27dom(body$27dom(), "ready-on");
      show_name$27219();
      return again$27intro();
    });
    on$27dom(by_id$27dom("ready-home"), click$27dom, function (e) {
      return stop$27225();
    });
    on$27dom(video, timeupdate$27media, function (e) {
      let at$27235, length$27236, r$27i146;
      (at$27235 = ((r$27i146 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i146))());
      (length$27236 = duration$27220());
      (($B["map?"](item$27214) ? (media_time$27media(video) > 0.0) : false) ? (reached$27216 = at$27235) : false);
      return text$21$27ready("ready-time", (($B["map?"](item$27214) ? (length$27236 > 0.0) : false) ? $B["string-append"](clock$27clock(at$27235), " / ", clock$27clock((length$27236 - at$27235))) : ""));
    });
    on$27dom(video, ended$27media, function (e) {
      let q$27237, r$27i147;
      (q$27237 = ((r$27i147 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r$27i147))());
      if (((q$27237) !== false ? (($B["map-ref"](q$27237, "at", 0) >= ($B["vector-length"]($B["map-ref"](q$27237, "items", $B["vector"]())) - 1)) ? $B["equal?"]($B["map-ref"](q$27237, "repeat", ""), "off") : false) : false)) {
        report$27222();
        return after$27page(500, stop$27225);
      } else {
        return false;
      }
    });
    on$27dom(screen$27211, mousemove$27dom, function (e) {
      return stirred$27223();
    });
    on$27dom(screen$27211, pointerdown$27dom, function (e) {
      return stirred$27223();
    });
    on$27dom(screen$27211, touchstart$27dom, function (e) {
      return stirred$27223();
    });
    on_document$27dom(keydown$27dom, function (e) {
      if (hidden$3f$27dom(screen$27211)) {
        return false;
      } else {
        return stirred$27223();
      }
    });
    on$27dom(video, play$27media, function (e) {
      return state$27221();
    });
    on$27dom(video, pause$27media, function (e) {
      state$27221();
      return report$27222();
    });
    on$27dom(video, volumechange$27media, function (e) {
      return state$27221();
    });
    on$27dom(video, seeked$27media, function (e) {
      return state$27221();
    });
    every$27page(1000, function () {
      if (($B["map?"](item$27214) ? (media_paused$3f$27media(video) === false) : false)) {
        return state$27221();
      } else {
        return false;
      }
    });
    every$27page(10000, function () {
      if (($B["map?"](item$27214) ? (media_paused$3f$27media(video) === false) : false)) {
        return report$27222();
      } else {
        return false;
      }
    });
    ((handler$27i148 = function (text, m) {
      return show_name$27219();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i148)))));
    ((handler$27i155 = function (text, p) {
      let r$27i149, r$27i150, r$27i152, r$27i153, x$27i151, x$27i154;
      (films$27213 = $B["map-set"](films$27213, $B["map-ref"](p, "file", 0), p));
      if ((((r$27i149 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i149))() ? (((r$27i150 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i150))() === ((x$27i151 = $B["map-ref"](p, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i151) ? (x$27i151 + 0.0) : 0.0))))) : false)) {
        return ((r$27i152 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 8, r$27i152))();
      } else {
        return ((r$27i153 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i153))(((x$27i154 = $B["map-ref"](p, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i154) ? (x$27i154 + 0.0) : 0.0)))));
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "play", $B["append"]($B["map-ref"](handlers$27socket, "play", null), $listFromEnd(handler$27i155)))));
    ((handler$27i158 = function (text, m) {
      let r$27i156, x$27i157;
      return ((r$27i156 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i156))(((x$27i157 = $B["map-ref"](m, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i157) ? (x$27i157 + 0.0) : 0.0)))));
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "music", $B["append"]($B["map-ref"](handlers$27socket, "music", null), $listFromEnd(handler$27i158)))));
    (handler$27i174 = function (text, m) {
      let at$27240, c$27238, or$27value$27241, or$27value$27242, or$27value$27244, q$27239, r$27i159, r$27i160, r$27i161, r$27i164, r$27i165, r$27i167, r$27i169, r$27i171, r$27i172, r$27i173, v$27243, x$27i162, x$27i163, x$27i166, x$27i168, x$27i170;
      (c$27238 = $B["map-ref"](m, "command", ""));
      (q$27239 = ((r$27i159 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 7, r$27i159))());
      (at$27240 = ((r$27i160 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 3, r$27i160))());
      ($B["equal?"](c$27238, "stop") ? stop$27225() : ((((r$27i161 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i161))() === false) ? false : (((or$27value$27241 = $B["equal?"](c$27238, "toggle")), (or$27value$27241 ? or$27value$27241 : ((or$27value$27242 = ($B["equal?"](c$27238, "play") ? ((q$27239) !== false ? ((x$27i162 = $B["map-ref"](q$27239, "paused", false)), ((x$27i162) !== false ? (((x$27i162 === $sym("null")) === false) ? (($B["equal?"](x$27i162, 0) === false) ? ($B["equal?"](x$27i162, "") === false) : false) : false) : false)) : false) : false)), (or$27value$27242 ? or$27value$27242 : ($B["equal?"](c$27238, "pause") ? ((q$27239) !== false ? (((x$27i163 = $B["map-ref"](q$27239, "paused", false)), ((x$27i163) !== false ? (((x$27i163 === $sym("null")) === false) ? (($B["equal?"](x$27i163, 0) === false) ? ($B["equal?"](x$27i163, "") === false) : false) : false) : false)) === false) : false) : false))))) ? ((r$27i164 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i164))("toggle", null) : ($B["equal?"](c$27238, "back") ? ((r$27i165 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i165))("seek", $listFromEnd($B["cons"]("value", ((v$27243 = ((x$27i166 = (at$27240 - 10.0)), $B["exact"]($B["floor"](($B["number?"](x$27i166) ? (x$27i166 + 0.0) : 0.0))))), ((v$27243 > 0) ? v$27243 : 0))))) : ($B["equal?"](c$27238, "forward") ? ((r$27i167 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i167))("seek", $listFromEnd($B["cons"]("value", ((x$27i168 = (at$27240 + 30.0)), $B["exact"]($B["floor"](($B["number?"](x$27i168) ? (x$27i168 + 0.0) : 0.0))))))) : ($B["equal?"](c$27238, "seek") ? ((r$27i169 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i169))("seek", $listFromEnd($B["cons"]("value", ((x$27i170 = $B["map-ref"](m, "value", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i170) ? (x$27i170 + 0.0) : 0.0))))))) : ($B["equal?"](c$27238, "next") ? ((r$27i171 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i171))("next", null) : ($B["equal?"](c$27238, "prev") ? ((r$27i172 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 2, r$27i172))("prev", null) : ($B["equal?"](c$27238, "volume-down") ? set_volume$21$27media(video, (volume$27media(video) - 0.10000000000000001)) : ($B["equal?"](c$27238, "volume-up") ? (set_muted$21$27media(video, false), set_volume$21$27media(video, (volume$27media(video) + 0.10000000000000001))) : ($B["equal?"](c$27238, "mute") ? set_muted$21$27media(video, (muted$3f$27media(video) === false)) : ($B["equal?"](c$27238, "subtitles") ? show_subtitles$21$27media(video, (subtitles_showing$3f$27media(video) ? -1 : 0)) : false))))))))))));
      if (((or$27value$27244 = $B["equal?"](c$27238, "stop")), (or$27value$27244 ? or$27value$27244 : ((r$27i173 = player$27217), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i173))()))) {
        return state$27221();
      } else {
        return false;
      }
    });
    return (handlers$27socket = $B["map-set"](handlers$27socket, "control", $B["append"]($B["map-ref"](handlers$27socket, "control", null), $listFromEnd(handler$27i174))));
  });
  (hide$21$27remote = function (id, hidden) {
    let e$27245;
    (e$27245 = by_id$27dom(id));
    if ((e$27245) !== false) {
      return set_hidden$21$27dom(e$27245, hidden);
    } else {
      return false;
    }
  });
  (text$21$27remote = function (id, text) {
    let e$27246;
    (e$27246 = by_id$27dom(id));
    if ((e$27246) !== false) {
      return set_text$21$27dom(e$27246, text);
    } else {
      return false;
    }
  });
  (as_queue$27remote = $B["map-of"]("toggle", "toggle", "play", "toggle", "pause", "toggle", "next", "next", "prev", "prev", "seek", "seek", "back", "seek", "forward", "seek"));
  (remote_controls$27remote = function () {
    let remote$27247;
    (remote$27247 = by_id$27dom("remote"));
    if ((remote$27247) !== false) {
      return controls$27remote(remote$27247);
    } else {
      return false;
    }
  });
  (controls$27remote = function (remote) {
    let button$27312, chosen$27248, command$27268, dragging$27249, find_playing$27260, from_queue$27258, handler$27i201, handler$27i204, handler$27i205, handler$27i206, has$3f$27261, list$27313, listed$27256, listing$27255, names$27250, names_of$27262, others$27259, queue_of$27257, queue_row$27267, queue_shape$27266, queues$27252, render$27264, seek$27254, seek_value$27269, show_queue$27265, states$27251, tab$21$27263, tabs$27253;
    (chosen$27248 = data_of$27dom(remote, "target"));
    (dragging$27249 = false);
    (names$27250 = "");
    (states$27251 = $B["map-of"]());
    (queues$27252 = $B["map-of"]());
    (tabs$27253 = by_id$27dom("remote-tabs"));
    (seek$27254 = by_id$27dom("remote-seek"));
    (listing$27255 = false);
    (listed$27256 = "");
    (queue_of$27257 = function (t) {
      let x$27i175;
      if (($B["map?"](t) ? (((x$27i175 = $B["map-ref"](t, "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i175) ? (x$27i175 + 0.0) : 0.0)))) > 0) : false)) {
        return $B["map-ref"](queues$27252, $B["map-ref"](t, "queue", 0), false);
      } else {
        return false;
      }
    });
    (from_queue$27258 = function (t) {
      let item$27271, kind$27272, or$27value$27274, paused$27273, q$27270, x$27i176, x$27i177, x$27i178, x$27i179, x$27i180, x$27i181, x$27i182, x$27i183;
      (q$27270 = queue_of$27257(t));
      if (((q$27270) !== false ? ($B["vector-length"]($B["map-ref"](q$27270, "items", $B["vector"]())) > 0) : false)) {
        (item$27271 = $B["vector-ref"]($B["map-ref"](q$27270, "items", $B["vector"]()), $B["map-ref"](q$27270, "at", 0)));
        (kind$27272 = $B["map-ref"](item$27271, "kind", ""));
        (paused$27273 = ((x$27i176 = $B["map-ref"](q$27270, "paused", false)), ((x$27i176) !== false ? (((x$27i176 === $sym("null")) === false) ? (($B["equal?"](x$27i176, 0) === false) ? ($B["equal?"](x$27i176, "") === false) : false) : false) : false)));
        if (((or$27value$27274 = $B["equal?"](kind$27272, "film")), (or$27value$27274 ? or$27value$27274 : $B["equal?"](kind$27272, "episode")))) {
          return false;
        } else {
          return $B["map-of"]("playing", true, "paused", paused$27273, "music", true, "title", ((x$27i177 = $B["map-ref"](item$27271, "title", "")), ($B["string?"](x$27i177) ? x$27i177 : ($B["number?"](x$27i177) ? $B["number->string"](x$27i177) : ""))), "label", ((x$27i178 = $B["map-ref"](item$27271, "artist", "")), ($B["string?"](x$27i178) ? x$27i178 : ($B["number?"](x$27i178) ? $B["number->string"](x$27i178) : ""))), "poster", ((x$27i179 = $B["map-ref"](item$27271, "art", "")), ($B["string?"](x$27i179) ? x$27i179 : ($B["number?"](x$27i179) ? $B["number->string"](x$27i179) : ""))), "next", 1, "subtitles", 0, "duration", ((x$27i180 = $B["map-ref"](item$27271, "duration", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i180) ? (x$27i180 + 0.0) : 0.0)))), "position", ((x$27i183 = (((x$27i181 = $B["map-ref"](q$27270, "position", 0)), ($B["number?"](x$27i181) ? (x$27i181 + 0.0) : 0.0)) + (paused$27273 ? 0.0 : ((now_ms$27page() - ((x$27i182 = $B["map-ref"](q$27270, "received", 0)), ($B["number?"](x$27i182) ? (x$27i182 + 0.0) : 0.0))) / 1000.0)))), $B["exact"]($B["floor"](($B["number?"](x$27i183) ? (x$27i183 + 0.0) : 0.0)))), "queue", $B["map-ref"](q$27270, "id", 0));
        }
      } else {
        return false;
      }
    });
    (others$27259 = function () {
      return other_screens$27where();
    });
    (find_playing$27260 = function (l) {
      let x$27i184;
      for (;;) {
        if ($B["null?"](l)) {
          return false;
        } else {
          if (((x$27i184 = $B["map-ref"]($B["map-ref"](states$27251, $B["map-ref"]($B["car"](l), "id", ""), $B["map-of"]()), "playing", false)), ((x$27i184) !== false ? (((x$27i184 === $sym("null")) === false) ? (($B["equal?"](x$27i184, 0) === false) ? ($B["equal?"](x$27i184, "") === false) : false) : false) : false))) {
            return $B["car"](l);
          } else {
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      }
    });
    (has$3f$27261 = function (l, id) {
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
    (names_of$27262 = function (l) {
      if ($B["null?"](l)) {
        return "";
      } else {
        return $B["string-append"]($B["map-ref"]($B["car"](l), "id", ""), "\n", $B["map-ref"]($B["car"](l), "name", ""), "\n", names_of$27262($B["cdr"](l)));
      }
    });
    (tab$21$27263 = function (t) {
      let b$27275;
      (b$27275 = make_element$27dom("button"));
      set_attribute$21$27dom(b$27275, "type", "button");
      set_attribute$21$27dom(b$27275, "role", "tab");
      set_attribute$21$27dom(b$27275, "data-screen", $B["map-ref"](t, "id", ""));
      set_text$21$27dom(b$27275, $B["map-ref"](t, "name", ""));
      return append$21$27dom(tabs$27253, b$27275);
    });
    (render$27264 = function () {
      let buttons$27280, duration$27289, each$27279, each$27281, list$27276, now$27278, or$27value$27285, or$27value$27286, or$27value$27292, playing$27277, playing$27284, position$27290, poster$27287, q$27291, s$27283, src$27288, subtitles$27293, x$27i185, x$27i186, x$27i187, x$27i188, x$27i189, x$27i190, x$27i191, x$27i192, x$27i193, x$27i194;
      (list$27276 = others$27259());
      hide$21$27remote("remote-ready", ($B["equal?"]($B["map-ref"](self$27socket, "role", ""), "play") === false));
      hide$21$27remote("remote-none", ($B["null?"](list$27276) === false));
      ((has$3f$27261(list$27276, chosen$27248)) !== false ? false : ((playing$27277 = find_playing$27260(list$27276)), (chosen$27248 = ((playing$27277) !== false ? $B["map-ref"](playing$27277, "id", "") : ($B["null?"](list$27276) ? "" : $B["map-ref"]($B["car"](list$27276), "id", ""))))));
      ((now$27278 = names_of$27262(list$27276)), ($B["equal?"](now$27278, names$27250) ? false : ((names$27250 = now$27278), clear$21$27dom(tabs$27253), ((each$27279 = function (l) {
        for (;;) {
          if ($B["null?"](l)) {
            return false;
          } else {
            tab$21$27263($B["car"](l));
            const $t0 = $B["cdr"](l);
            l = $t0;
            continue;
          }
        }
      }), each$27279(list$27276)))));
      ((buttons$27280 = query_all$27dom("#remote-tabs [data-screen]")), (each$27281 = function (i) {
        let b$27282;
        for (;;) {
          if ((i < $B["vector-length"](buttons$27280))) {
            (b$27282 = $B["vector-ref"](buttons$27280, i));
            set_attribute$21$27dom(b$27282, "aria-selected", ($B["equal?"](data_of$27dom(b$27282, "screen"), chosen$27248) ? "true" : "false"));
            const $t0 = (i + 1);
            i = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27281(0));
      (s$27283 = ((or$27value$27285 = from_queue$27258(screen_of$27where(chosen$27248))), ((or$27value$27285) !== false ? or$27value$27285 : $B["map-ref"](states$27251, chosen$27248, false))));
      (playing$27284 = ((s$27283) !== false ? ((x$27i185 = $B["map-ref"](s$27283, "playing", false)), ((x$27i185) !== false ? (((x$27i185 === $sym("null")) === false) ? (($B["equal?"](x$27i185, 0) === false) ? ($B["equal?"](x$27i185, "") === false) : false) : false) : false)) : false));
      hide$21$27remote("remote-now", (playing$27284 === false));
      hide$21$27remote("remote-idle", ((or$27value$27286 = $B["equal?"](chosen$27248, "")), (or$27value$27286 ? or$27value$27286 : playing$27284)));
      if (playing$27284) {
        (poster$27287 = by_id$27dom("remote-poster"));
        (src$27288 = ((x$27i186 = $B["map-ref"](s$27283, "poster", "")), ($B["string?"](x$27i186) ? x$27i186 : ($B["number?"](x$27i186) ? $B["number->string"](x$27i186) : ""))));
        (duration$27289 = ((x$27i187 = $B["map-ref"](s$27283, "duration", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i187) ? (x$27i187 + 0.0) : 0.0)))));
        (position$27290 = ((x$27i188 = $B["map-ref"](s$27283, "position", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i188) ? (x$27i188 + 0.0) : 0.0)))));
        (q$27291 = queue_of$27257(screen_of$27where(chosen$27248)));
        ((poster$27287) !== false ? (set_hidden$21$27dom(poster$27287, $B["equal?"](src$27288, "")), ((($B["equal?"](src$27288, "") === false) ? ($B["equal?"](attribute_of$27dom(poster$27287, "src"), src$27288) === false) : false) ? set_attribute$21$27dom(poster$27287, "src", src$27288) : false)) : false);
        text$21$27remote("remote-title", ((x$27i189 = $B["map-ref"](s$27283, "title", "")), ($B["string?"](x$27i189) ? x$27i189 : ($B["number?"](x$27i189) ? $B["number->string"](x$27i189) : ""))));
        text$21$27remote("remote-label", ((x$27i190 = $B["map-ref"](s$27283, "label", "")), ($B["string?"](x$27i190) ? x$27i190 : ($B["number?"](x$27i190) ? $B["number->string"](x$27i190) : ""))));
        ((dragging$27249) !== false ? false : (set_attribute$21$27dom(seek$27254, "max", $B["number->string"](duration$27289)), set_field$21$27dom(seek$27254, $B["number->string"](position$27290)), text$21$27remote("remote-time", $B["string-append"](clock$27clock((0.0 + position$27290)), " / ", clock$27clock((0.0 + duration$27289))))));
        hide$21$27remote("remote-play", (((x$27i191 = $B["map-ref"](s$27283, "paused", false)), ((x$27i191) !== false ? (((x$27i191 === $sym("null")) === false) ? (($B["equal?"](x$27i191, 0) === false) ? ($B["equal?"](x$27i191, "") === false) : false) : false) : false)) === false));
        hide$21$27remote("remote-pause", ((x$27i192 = $B["map-ref"](s$27283, "paused", false)), ((x$27i192) !== false ? (((x$27i192 === $sym("null")) === false) ? (($B["equal?"](x$27i192, 0) === false) ? ($B["equal?"](x$27i192, "") === false) : false) : false) : false)));
        hide$21$27remote("remote-next-slot", ((q$27291) !== false ? (((or$27value$27292 = ($B["map-ref"](q$27291, "at", 0) < ($B["vector-length"]($B["map-ref"](q$27291, "items", $B["vector"]())) - 1))), (or$27value$27292 ? or$27value$27292 : $B["equal?"]($B["map-ref"](q$27291, "repeat", ""), "all"))) === false) : (((x$27i193 = $B["map-ref"](s$27283, "next", false)), ((x$27i193) !== false ? (((x$27i193 === $sym("null")) === false) ? (($B["equal?"](x$27i193, 0) === false) ? ($B["equal?"](x$27i193, "") === false) : false) : false) : false)) === false)));
        hide$21$27remote("remote-prev-slot", (((q$27291) !== false ? ($B["vector-length"]($B["map-ref"](q$27291, "items", $B["vector"]())) > 0) : false) === false));
        ((subtitles$27293 = query_in$27dom(remote, "[data-command=subtitles]")), ((subtitles$27293) !== false ? set_hidden$21$27dom(subtitles$27293, (((x$27i194 = $B["map-ref"](s$27283, "subtitles", false)), ((x$27i194) !== false ? (((x$27i194 === $sym("null")) === false) ? (($B["equal?"](x$27i194, 0) === false) ? ($B["equal?"](x$27i194, "") === false) : false) : false) : false)) === false)) : false));
        return show_queue$27265(q$27291);
      } else {
        return false;
      }
    });
    (show_queue$27265 = function (q) {
      let at$27296, each$27298, items$27295, list$27294, shape$27297;
      (list$27294 = by_id$27dom("remote-queue"));
      if ((list$27294) !== false) {
        if ((((listing$27255) !== false ? q : false) === false)) {
          set_hidden$21$27dom(list$27294, true);
          return (listed$27256 = "");
        } else {
          (items$27295 = $B["map-ref"](q, "items", $B["vector"]()));
          (at$27296 = $B["map-ref"](q, "at", 0));
          (shape$27297 = queue_shape$27266(items$27295, at$27296));
          set_hidden$21$27dom(list$27294, false);
          if ($B["equal?"](shape$27297, listed$27256)) {
            return false;
          } else {
            (listed$27256 = shape$27297);
            clear$21$27dom(list$27294);
            (each$27298 = function (i) {
              for (;;) {
                if ((i < $B["vector-length"](items$27295))) {
                  append$21$27dom(list$27294, queue_row$27267($B["vector-ref"](items$27295, i), (i === at$27296)));
                  const $t0 = (i + 1);
                  i = $t0;
                  continue;
                } else {
                  return false;
                }
              }
            });
            return each$27298(0);
          }
        }
      } else {
        return false;
      }
    });
    (queue_shape$27266 = function (items, at) {
      let each$27299;
      (each$27299 = function (i, out) {
        let x$27i195;
        for (;;) {
          if ((i < $B["vector-length"](items))) {
            const $t0 = (i + 1);
            const $t1 = $B["string-append"](out, ";", $B["number->string"](((x$27i195 = $B["map-ref"]($B["vector-ref"](items, i), "id", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i195) ? (x$27i195 + 0.0) : 0.0))))));
            i = $t0;
            out = $t1;
            continue;
          } else {
            return out;
          }
        }
      });
      return each$27299(0, $B["number->string"](at));
    });
    (queue_row$27267 = function (item, playing) {
      let artist$27302, b$27301, li$27300, x$27i196, x$27i197, x$27i198;
      (li$27300 = make_element$27dom("li"));
      (b$27301 = make_element$27dom("button"));
      set_attribute$21$27dom(b$27301, "type", "button");
      set_attribute$21$27dom(b$27301, "data-item", $B["number->string"](((x$27i196 = $B["map-ref"](item, "id", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i196) ? (x$27i196 + 0.0) : 0.0))))));
      set_attribute$21$27dom(b$27301, "class", (playing ? "remote-row playing" : "remote-row"));
      set_text$21$27dom(b$27301, ((artist$27302 = ((x$27i197 = $B["map-ref"](item, "artist", "")), ($B["string?"](x$27i197) ? x$27i197 : ($B["number?"](x$27i197) ? $B["number->string"](x$27i197) : "")))), $B["string-append"](((x$27i198 = $B["map-ref"](item, "title", "")), ($B["string?"](x$27i198) ? x$27i198 : ($B["number?"](x$27i198) ? $B["number->string"](x$27i198) : ""))), ($B["equal?"](artist$27302, "") ? "" : $B["string-append"](" \xc2\xb7 ", artist$27302)))));
      append$21$27dom(li$27300, b$27301);
      return li$27300;
    });
    (command$27268 = function (name, value) {
      let msg$27i199, msg$27i200, op$27304, position$27305, q$27303;
      if ($B["equal?"](chosen$27248, "")) {
        return false;
      } else {
        (q$27303 = from_queue$27258(screen_of$27where(chosen$27248)));
        (op$27304 = $B["map-ref"](as_queue$27remote, name, false));
        if ((((q$27303) !== false ? op$27304 : false)) !== false) {
          (position$27305 = $B["map-ref"](q$27303, "position", 0));
          (msg$27i199 = $B["map-of"]("type", "queue", "op", op$27304, "queue", $B["map-ref"](q$27303, "queue", 0), "value", ($B["equal?"](name, "back") ? ((position$27305 > 10) ? (position$27305 - 10) : 0) : ($B["equal?"](name, "forward") ? (position$27305 + 30) : value))));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i199));
          } else {
            return false;
          }
        } else {
          (msg$27i200 = $B["map-of"]("type", "control", "target", chosen$27248, "command", name, "value", value));
          if ((open_socket$27socket) !== false) {
            return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i200));
          } else {
            return false;
          }
        }
      }
    });
    (seek_value$27269 = function () {
      let n$27306;
      (n$27306 = $B["string->number"](value_of$27dom(seek$27254)));
      if ((n$27306) !== false) {
        return n$27306;
      } else {
        return 0;
      }
    });
    ((handler$27i201 = function (text, m) {
      (queues$27252 = $B["map-set"](queues$27252, $B["map-ref"](m, "id", 0), $B["map-set"](m, "received", now_ms$27page())));
      return render$27264();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queue", $B["append"]($B["map-ref"](handlers$27socket, "queue", null), $listFromEnd(handler$27i201)))));
    ((handler$27i204 = function (text, m) {
      let each$27308, l$27307;
      ((l$27307 = $B["map-ref"](m, "targets", $B["vector"]())), (each$27308 = function (i) {
        let msg$27i203, q$27309, x$27i202;
        for (;;) {
          if ((i < $B["vector-length"](l$27307))) {
            (q$27309 = ((x$27i202 = $B["map-ref"]($B["vector-ref"](l$27307, i), "queue", 0)), $B["exact"]($B["floor"](($B["number?"](x$27i202) ? (x$27i202 + 0.0) : 0.0)))));
            (((q$27309 > 0) ? ($B["map-ref"](queues$27252, q$27309, false) === false) : false) ? ((msg$27i203 = $B["map-of"]("type", "queue", "op", "state", "queue", q$27309)), ((open_socket$27socket) !== false ? socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i203)) : false)) : false);
            const $t0 = (i + 1);
            i = $t0;
            continue;
          } else {
            return false;
          }
        }
      }), each$27308(0));
      return render$27264();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "targets", $B["append"]($B["map-ref"](handlers$27socket, "targets", null), $listFromEnd(handler$27i204)))));
    ((handler$27i205 = function (text, m) {
      return render$27264();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i205)))));
    ((handler$27i206 = function (text, s) {
      (states$27251 = $B["map-set"](states$27251, $B["map-ref"](s, "from", ""), s));
      return render$27264();
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "state", $B["append"]($B["map-ref"](handlers$27socket, "state", null), $listFromEnd(handler$27i206)))));
    every$27page(1000, function () {
      if ((from_queue$27258(screen_of$27where(chosen$27248))) !== false) {
        return render$27264();
      } else {
        return false;
      }
    });
    on$27dom(tabs$27253, click$27dom, function (e) {
      let b$27310;
      (b$27310 = closest_of$27dom(e, "[data-screen]"));
      if ((b$27310) !== false) {
        (chosen$27248 = data_of$27dom(b$27310, "screen"));
        return render$27264();
      } else {
        return false;
      }
    });
    on$27dom(remote, click$27dom, function (e) {
      let b$27311;
      (b$27311 = closest_of$27dom(e, "[data-command]"));
      if ((b$27311) !== false) {
        return command$27268(data_of$27dom(b$27311, "command"), 0);
      } else {
        return false;
      }
    });
    ((button$27312 = by_id$27dom("remote-list")), ((button$27312) !== false ? on$27dom(button$27312, click$27dom, function (e) {
      (listing$27255 = (listing$27255 === false));
      set_attribute$21$27dom(button$27312, "aria-expanded", ((listing$27255) !== false ? "true" : "false"));
      return render$27264();
    }) : false));
    ((list$27313 = by_id$27dom("remote-queue")), ((list$27313) !== false ? on$27dom(list$27313, click$27dom, function (e) {
      let b$27314, msg$27i207, n$27316, q$27315;
      (b$27314 = closest_of$27dom(e, "[data-item]"));
      (q$27315 = queue_of$27257(screen_of$27where(chosen$27248)));
      if ((((b$27314) !== false ? q$27315 : false)) !== false) {
        (msg$27i207 = $B["map-of"]("type", "queue", "op", "jump", "queue", $B["map-ref"](q$27315, "id", 0), "item", ((n$27316 = $B["string->number"](data_of$27dom(b$27314, "item"))), ((n$27316) !== false ? n$27316 : 0))));
        if ((open_socket$27socket) !== false) {
          return socket_send$21$27browser$2fsocket(open_socket$27socket, $B["json-write"](msg$27i207));
        } else {
          return false;
        }
      } else {
        return false;
      }
    }) : false));
    on$27dom(seek$27254, input$27dom, function (e) {
      let x$27i208, x$27i209;
      (dragging$27249 = true);
      return text$21$27remote("remote-time", $B["string-append"](clock$27clock(((x$27i208 = seek_value$27269()), ($B["number?"](x$27i208) ? (x$27i208 + 0.0) : 0.0))), " / ", clock$27clock(((x$27i209 = $B["map-ref"]($B["map-ref"](states$27251, chosen$27248, $B["map-of"]()), "duration", 0)), ($B["number?"](x$27i209) ? (x$27i209 + 0.0) : 0.0)))));
    });
    on$27dom(seek$27254, change$27dom, function (e) {
      (dragging$27249 = false);
      return command$27268("seek", seek_value$27269());
    });
    return render$27264();
  });
  (bar_player$27bar = false);
  (bar_key$27bar = "hazelflix-bar");
  (bar_wake$21$27bar = function (queue) {
    let r$27i211, r$27i212, r$27i213;
    if ((bar_player$27bar) !== false) {
      ((((r$27i211 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i211))() ? (((r$27i212 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i212))() === queue) : false) ? false : ((r$27i213 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i213))(queue));
      return true;
    } else {
      return false;
    }
  });
  (nothing$27bar = function () {
    return false;
  });
  (players_start$27bar = function () {
    let bar$27318, close$27dom$27319, film$27i214, film$27i217, handler$27i225, on_load$27i215, on_load$27i218, on_sleep$27i220, on_wake$27i219, screen$27317;
    (screen$27317 = by_id$27dom("player-screen"));
    (bar$27318 = by_id$27dom("music-bar"));
    if ((screen$27317) !== false) {
      return start_player$27player(screen$27317, ((film$27i214 = function (item) {
        return false;
      }), (on_load$27i215 = function (item, p) {
        return false;
      }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", false, false, film$27i214, on_load$27i215, nothing$27bar, nothing$27bar)));
    } else {
      if ((bar$27318) !== false) {
        (bar_player$27bar = start_player$27player(bar$27318, ((film$27i217 = function (item) {
          return false;
        }), (on_load$27i218 = function (item, p) {
          return false;
        }), (on_wake$27i219 = function () {
          let r$27i216;
          set_hidden$21$27dom(bar$27318, false);
          add_class$21$27dom(body$27dom(), "with-bar");
          session_set$21$27page(bar_key$27bar, $B["number->string"](((r$27i216 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 6, r$27i216))()));
          return false;
        }), (on_sleep$27i220 = function () {
          set_hidden$21$27dom(bar$27318, true);
          remove_class$21$27dom(body$27dom(), "with-bar");
          session_remove$21$27page(bar_key$27bar);
          return false;
        }), $B["%record-make"]("a3790718d7b36d9f|player-options|asleep bar film on-load on-wake on-sleep|", true, true, film$27i217, on_load$27i218, on_wake$27i219, on_sleep$27i220))));
        ((close$27dom$27319 = query_in$27dom(bar$27318, "[data-bar-close]")), ((close$27dom$27319) !== false ? on$27dom(close$27dom$27319, click$27dom, function (e) {
          let r$27i221;
          return ((r$27i221 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 1, r$27i221))();
        }) : false));
        (handler$27i225 = function (text, m) {
          let r$27i223, r$27i224, was$27320, x$27i222;
          (was$27320 = ((x$27i222 = $B["string->number"](session_get$27page(bar_key$27bar))), $B["exact"]($B["floor"](($B["number?"](x$27i222) ? (x$27i222 + 0.0) : 0.0)))));
          if (((was$27320 > 0) ? (((r$27i223 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i223))() === false) : false)) {
            return ((r$27i224 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 0, r$27i224))(was$27320);
          } else {
            return false;
          }
        });
        return (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i225))));
      } else {
        return false;
      }
    }
  });
  (digits$3f$27bar = function (s, from) {
    let loop$27321;
    if ((from < $B["string-length"](s))) {
      (loop$27321 = function (i) {
        let b$27322;
        for (;;) {
          if ((i === $B["string-length"](s))) {
            return true;
          } else {
            if (((b$27322 = $B["byte-ref"](s, i)), ((b$27322 >= 48) ? (b$27322 <= 57) : false))) {
              const $t0 = (i + 1);
              i = $t0;
              continue;
            } else {
              return false;
            }
          }
        }
      });
      return loop$27321(from);
    } else {
      return false;
    }
  });
  (site_path$27bar = function (url) {
    let cut$27324, origin$27page$27323;
    (origin$27page$27323 = origin$27page());
    if (($B["string-prefix?"](origin$27page$27323, url) ? $B["string-prefix?"]("/", $B["substring"](url, $B["string-length"](origin$27page$27323), $B["string-length"](url))) : false)) {
      (cut$27324 = function (p, i) {
        let or$27value$27325;
        for (;;) {
          if ((i === $B["string-length"](p))) {
            if (((i > 1) ? $B["string-suffix?"]("/", p) : false)) {
              return $B["substring"](p, 0, (i - 1));
            } else {
              return p;
            }
          } else {
            if (((or$27value$27325 = ($B["byte-ref"](p, i) === 63)), (or$27value$27325 ? or$27value$27325 : ($B["byte-ref"](p, i) === 35)))) {
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
      return cut$27324($B["substring"](url, $B["string-length"](origin$27page$27323), $B["string-length"](url)), 0);
    } else {
      return false;
    }
  });
  (swappable$3f$27bar = function (url) {
    let or$27value$27327, or$27value$27328, or$27value$27329, or$27value$27330, or$27value$27331, or$27value$27332, or$27value$27333, p$27326;
    (p$27326 = site_path$27bar(url));
    if ((p$27326) !== false) {
      (or$27value$27327 = $B["equal?"](p$27326, "/music"));
      if (or$27value$27327) {
        return or$27value$27327;
      } else {
        (or$27value$27328 = $B["equal?"](p$27326, "/music/songs"));
        if (or$27value$27328) {
          return or$27value$27328;
        } else {
          (or$27value$27329 = $B["equal?"](p$27326, "/music/videos"));
          if (or$27value$27329) {
            return or$27value$27329;
          } else {
            (or$27value$27330 = $B["equal?"](p$27326, "/music/artists"));
            if (or$27value$27330) {
              return or$27value$27330;
            } else {
              (or$27value$27331 = $B["equal?"](p$27326, "/music/playlists"));
              if (or$27value$27331) {
                return or$27value$27331;
              } else {
                (or$27value$27332 = ($B["string-prefix?"]("/album/", p$27326) ? digits$3f$27bar(p$27326, 7) : false));
                if ((or$27value$27332) !== false) {
                  return or$27value$27332;
                } else {
                  (or$27value$27333 = ($B["string-prefix?"]("/artist/", p$27326) ? digits$3f$27bar(p$27326, 8) : false));
                  if ((or$27value$27333) !== false) {
                    return or$27value$27333;
                  } else {
                    if ($B["string-prefix?"]("/playlist/", p$27326)) {
                      return digits$3f$27bar(p$27326, 10);
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
    let or$27value$27334, or$27value$27335;
    (or$27value$27334 = $B["equal?"](id_of$27dom(e), "music-bar"));
    if (or$27value$27334) {
      return or$27value$27334;
    } else {
      (or$27value$27335 = $B["equal?"](tag_of$27dom(e), "SCRIPT"));
      if (or$27value$27335) {
        return or$27value$27335;
      } else {
        return $B["equal?"](id_of$27dom(e), "intro");
      }
    }
  });
  (go$27bar = function (url, push) {
    return fetch_text$27fetch(url, function (status, text) {
      let bar$27340, coming$27345, doc$27336, each$27344, each$27346, fresh$27338, fresh_body$27337, here$27339, new_style$27342, now$27343, old_style$27341;
      if ((status === 0)) {
        return go$21$27page(url);
      } else {
        (doc$27336 = read_page$27page(text));
        (fresh_body$27337 = body_of$27dom(doc$27336));
        (fresh$27338 = ((fresh_body$27337) !== false ? first_element_of$27dom(fresh_body$27337) : false));
        (here$27339 = first_element_of$27dom(body$27dom()));
        (bar$27340 = by_id$27dom("music-bar"));
        if ((((fresh$27338) !== false ? ((here$27339) !== false ? ((bar$27340) !== false ? query_in$27dom(doc$27336, "main") : false) : false) : false)) !== false) {
          (old_style$27341 = head_style$27page(this_page$27dom()));
          (new_style$27342 = head_style$27page(doc$27336));
          ((((old_style$27341) !== false ? new_style$27342 : false)) !== false ? set_text$21$27dom(old_style$27341, text_of$27dom(new_style$27342)) : false);
          set_page_title$21$27page(page_title$27page(doc$27336));
          ((now$27343 = children_of$27dom(here$27339)), ((each$27344 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](now$27343))) {
                (kept$3f$27bar($B["vector-ref"](now$27343, i)) ? false : remove$21$27dom($B["vector-ref"](now$27343, i)));
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          }), each$27344(0)));
          ((coming$27345 = children_of$27dom(fresh$27338)), ((each$27346 = function (i) {
            for (;;) {
              if ((i < $B["vector-length"](coming$27345))) {
                (kept$3f$27bar($B["vector-ref"](coming$27345, i)) ? false : insert_before$21$27dom(here$27339, import$21$27dom($B["vector-ref"](coming$27345, i)), bar$27340));
                const $t0 = (i + 1);
                i = $t0;
                continue;
              } else {
                return false;
              }
            }
          }), each$27346(0)));
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
        let a$27347, r$27i210$27i226, url$27348;
        if ((((bar_player$27bar) !== false ? ((r$27i210$27i226 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i210$27i226))() : false) ? ((default_prevented$3f$27dom(e) === false) ? plain_click$3f$27dom(e) : false) : false)) {
          (a$27347 = closest_of$27dom(e, "a[href]"));
          if ((a$27347) !== false) {
            (url$27348 = link_address$27page(a$27347));
            if (((($B["equal?"](url$27348, "") === false) ? swappable$3f$27bar(url$27348) : false)) !== false) {
              prevent_default$21$27dom(e);
              return go$27bar(url$27348, true);
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
        let r$27i210$27i227;
        if (((((bar_player$27bar) !== false ? ((r$27i210$27i227 = bar_player$27bar), $B["%record-ref"]("43a613ede2ac6af5|player|wake sleep send position current playing? queue state reload media|", 5, r$27i210$27i227))() : false) ? swappable$3f$27bar(address$27page()) : false)) !== false) {
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
      let t$27350;
      if ($B["null?"](l)) {
        return null;
      } else {
        (t$27350 = $B["car"](l));
        return $B["cons"]($B["cons"]($B["map-ref"](t$27350, "name", ""), function () {
          return send$27music($B["map-set"](msg, "target", $B["map-ref"](t$27350, "id", "")));
        }), choices($B["cdr"](l)));
      }
    });
    return choose$27ui("Play where?", $B["cons"]($B["cons"]("This browser", function () {
      return send$27music(msg);
    }), choices(there)));
  });
  (music_buttons$27music = function () {
    let handler$27i232, handler$27i233;
    on_document$27dom(click$27dom, function (e) {
      let b$27351, msg$27352, n$27349$27i229, n$27349$27i231, s$27i228, s$27i230, there$27353;
      (b$27351 = closest_of$27dom(e, "[data-music]"));
      if ((b$27351) !== false) {
        (msg$27352 = $B["map-of"]("type", "queue", "op", data_of$27dom(b$27351, "music"), "what", data_of$27dom(b$27351, "what"), "id", ((s$27i228 = data_of$27dom(b$27351, "id")), ((n$27349$27i229 = $B["string->number"](s$27i228)), ((n$27349$27i229) !== false ? n$27349$27i229 : 0))), "start", ((s$27i230 = data_of$27dom(b$27351, "start")), ((n$27349$27i231 = $B["string->number"](s$27i230)), ((n$27349$27i231) !== false ? n$27349$27i231 : 0))), "shuffle", $B["equal?"](data_of$27dom(b$27351, "shuffle"), "1"), "next", $B["equal?"](data_of$27dom(b$27351, "next"), "1"), "queue", queue_now$27player));
        (there$27353 = other_screens$27where());
        prevent_default$21$27dom(e);
        if (($B["equal?"](data_of$27dom(b$27351, "music"), "play") ? (($B["null?"](there$27353) === false) ? (dialogs$3f$27dom() ? (by_id$27dom("player-screen") === false) : false) : false) : false)) {
          return ask_where$27music(msg$27352, there$27353);
        } else {
          return send$27music(msg$27352);
        }
      } else {
        return false;
      }
    });
    ((handler$27i232 = function (text, m) {
      let name$27354;
      if ((by_id$27dom("player-screen")) !== false) {
        return false;
      } else {
        if (($B["map-ref"](m, "elsewhere", false)) !== false) {
          return note$27ui(((name$27354 = $B["map-ref"](m, "name", "")), ($B["equal?"](name$27354, "") ? "Playing on the player that's open." : $B["string-append"]("Playing on ", name$27354, "."))));
        } else {
          if (bar_wake$21$27bar($B["map-ref"](m, "queue", 0))) {
            return false;
          } else {
            return go$21$27page($B["string-append"]("/music/player?queue=", $B["number->string"]($B["map-ref"](m, "queue", 0))));
          }
        }
      }
    }), (handlers$27socket = $B["map-set"](handlers$27socket, "queued", $B["append"]($B["map-ref"](handlers$27socket, "queued", null), $listFromEnd(handler$27i232)))));
    (handler$27i233 = function (text, m) {
      let n$27355;
      (n$27355 = $B["map-ref"](m, "n", 1));
      return note$27ui(((n$27355 === 1) ? "Added to the queue." : $B["string-append"]($B["number->string"](n$27355), " added to the queue.")));
    });
    return (handlers$27socket = $B["map-set"](handlers$27socket, "added", $B["append"]($B["map-ref"](handlers$27socket, "added", null), $listFromEnd(handler$27i233))));
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
    let chooser$27359, finished$27367, going$27362, handler$27i247, line_for$27364, lines$27360, made$27363, next$27366, queue$27361, send_file$27368, sending$3f$27365, watch$27369;
    (chooser$27359 = by_id$27dom("photo-files"));
    (lines$27360 = by_id$27dom("photo-uploads"));
    (queue$27361 = null);
    (going$27362 = 0);
    (made$27363 = 0);
    (line_for$27364 = function (name) {
      let l$27370;
      (l$27370 = make_element$27dom("div"));
      set_text$21$27dom(l$27370, $B["string-append"](name, ": waiting"));
      append$21$27dom(lines$27360, l$27370);
      return l$27370;
    });
    (sending$3f$27365 = function () {
      let or$27value$27371;
      (or$27value$27371 = (going$27362 > 0));
      if (or$27value$27371) {
        return or$27value$27371;
      } else {
        return $B["pair?"](queue$27361);
      }
    });
    (next$27366 = function () {
      let f$27372;
      for (;;) {
        if (((going$27362 < at_once$27photos) ? $B["pair?"](queue$27361) : false)) {
          (f$27372 = $B["car"](queue$27361));
          (queue$27361 = $B["cdr"](queue$27361));
          (going$27362 = (going$27362 + 1));
          send_file$27368(f$27372);
          continue;
        } else {
          return false;
        }
      }
    });
    (finished$27367 = function () {
      (going$27362 = (going$27362 - 1));
      return next$27366();
    });
    (send_file$27368 = function (f) {
      let began$27377, failed$27378, from$27379, id$27375, line$27376, name$27373, size$27374;
      (name$27373 = file_name$27fetch(f));
      (size$27374 = file_size$27fetch(f));
      (id$27375 = $B["random-hex"](16));
      (line$27376 = line_for$27364(name$27373));
      (began$27377 = now_ms$27page());
      (failed$27378 = function (why) {
        set_text$21$27dom(line$27376, $B["string-append"](name$27373, ": ", why));
        set_style$21$27dom(line$27376, "color", "#f0b446");
        return finished$27367();
      });
      (from$27379 = function (at, tried) {
        let asked$27381, end$27380, id$27i234, most$27382, name$27i235, size$27i236;
        (end$27380 = (((at + piece$27photos) > size$27374) ? size$27374 : (at + piece$27photos)));
        (asked$27381 = now_ms$27page());
        (most$27382 = 0);
        return post_piece_watched$21$27fetch(((id$27i234 = id$27375), (name$27i235 = name$27373), (size$27i236 = size$27374), $B["string-append"]("/photos/upload?id=", id$27i234, "&name=", encode_component$27page(name$27i235), "&size=", $B["number->string"](size$27i236))), f, at, end$27380, quiet_ms$27photos, function (sent) {
          let bytes$27i237, mb$27358$27i239, ms$27i238;
          ((sent > most$27382) ? (most$27382 = sent) : false);
          return set_text$21$27dom(line$27376, $B["string-append"](name$27373, ": ", $B["number->string"]($B["quotient"]((100 * (at + sent)), size$27374)), "%", ((bytes$27i237 = (at + sent)), (ms$27i238 = (now_ms$27page() - began$27377)), ((ms$27i238 < 500.0) ? "" : ((mb$27358$27i239 = (((bytes$27i237 + 0.0) / 1048576.0) / (ms$27i238 / 1000.0))), $B["string-append"](", ", $B["number->string"](($B["round"]((mb$27358$27i239 * 10.0)) / 10.0)), " MB/s"))))));
        }, function (status, body$27dom) {
          let bytes$27i244, m$27356$27i240, m$27356$27i242, mb$27358$27i246, ms$27i245, v$27357$27i241, v$27357$27i243, why$27383;
          post_form$21$27fetch("/photos/log", $B["string-append"]("line=", encode_component$27page($B["string-append"]("page ", $B["substring"](id$27375, 0, 6), " at ", $B["number->string"](at), "-", $B["number->string"](end$27380), " try ", $B["number->string"](tried), ": status ", $B["number->string"](status), " after ", $B["number->string"]($B["exact"]($B["round"]((now_ms$27page() - asked$27381)))), " ms, ", $B["number->string"](most$27382), " bytes seen going, ", (($B["string-length"](body$27dom) > 60) ? $B["substring"](body$27dom, 0, 60) : body$27dom)))));
          if ((((status <= 0) ? (tried < tries$27photos) : false)) !== false) {
            set_text$21$27dom(line$27376, $B["string-append"](name$27373, ": ", ((status === -1) ? $B["string-append"]("the phone wouldn't hand it over (", body$27dom, "), trying again") : "stalled, trying again")));
            return after$27page(2000, function () {
              return from$27379(at, (tried + 1));
            });
          } else {
            if ((status === -1)) {
              return failed$27378($B["string-append"]("the phone wouldn't hand it over (", body$27dom, ")"));
            } else {
              if (((status === 200) === false)) {
                return failed$27378(((why$27383 = ((m$27356$27i240 = $B["json-parse"](body$27dom, false)), ($B["map?"](m$27356$27i240) ? ((v$27357$27i241 = $B["map-ref"](m$27356$27i240, "error", "")), ($B["string?"](v$27357$27i241) ? v$27357$27i241 : "")) : ""))), ($B["equal?"](why$27383, "") ? "couldn't be sent" : why$27383)));
              } else {
                if ((end$27380 < size$27374)) {
                  return from$27379(end$27380, 1);
                } else {
                  if ($B["equal?"](((m$27356$27i242 = $B["json-parse"](body$27dom, false)), ($B["map?"](m$27356$27i242) ? ((v$27357$27i243 = $B["map-ref"](m$27356$27i242, "state", "")), ($B["string?"](v$27357$27i243) ? v$27357$27i243 : "")) : "")), "known")) {
                    set_text$21$27dom(line$27376, $B["string-append"](name$27373, ": already here"));
                    return finished$27367();
                  } else {
                    (made$27363 = (made$27363 + 1));
                    set_text$21$27dom(line$27376, $B["string-append"](name$27373, ": sent", ((bytes$27i244 = size$27374), (ms$27i245 = (now_ms$27page() - began$27377)), ((ms$27i245 < 500.0) ? "" : ((mb$27358$27i246 = (((bytes$27i244 + 0.0) / 1048576.0) / (ms$27i245 / 1000.0))), $B["string-append"](", ", $B["number->string"](($B["round"]((mb$27358$27i246 * 10.0)) / 10.0)), " MB/s")))), ", being made ready"));
                    return finished$27367();
                  }
                }
              }
            }
          }
        });
      });
      if ((size$27374 === 0)) {
        return failed$27378("empty");
      } else {
        if ((size$27374 > piece$27photos)) {
          return failed$27378("too large: 64 MB at most");
        } else {
          return from$27379(0, 1);
        }
      }
    });
    if ((chooser$27359 === false)) {
      return false;
    } else {
      (watch$27369 = function (input$27dom) {
        return on$27dom(input$27dom, change$27dom, function (e) {
          (queue$27361 = $B["append"](queue$27361, $B["vector->list"](chosen_files$27fetch(input$27dom))));
          watch$27369(file_input_again$21$27fetch(input$27dom));
          return next$27366();
        });
      });
      watch$27369(chooser$27359);
      ((handler$27i247 = function (text, msg) {
        let or$27value$27384;
        if (((((or$27value$27384 = (made$27363 > 0)), (or$27value$27384 ? or$27value$27384 : query$27dom("[data-photos-making]")))) !== false ? (sending$3f$27365() === false) : false)) {
          return reload$21$27page();
        } else {
          return false;
        }
      }), (handlers$27socket = $B["map-set"](handlers$27socket, "photos", $B["append"]($B["map-ref"](handlers$27socket, "photos", null), $listFromEnd(handler$27i247)))));
      return photo_dialog$27photos();
    }
  });
  (place_pin$27photos = function (place) {
    let pin$27385;
    (pin$27385 = by_id$27dom("photo-dialog-place"));
    if ((pin$27385) !== false) {
      set_attribute$21$27dom(pin$27385, "data-place", place);
      return set_hidden$21$27dom(pin$27385, $B["equal?"](place, ""));
    } else {
      return false;
    }
  });
  (photo_dialog$27photos = function () {
    let cancel$27389, d$27386, delete$27390, pin$27388;
    (d$27386 = by_id$27dom("photo-dialog"));
    if (((d$27386) !== false ? dialogs$3f$27dom() : false)) {
      each_of$27photos($B["vector->list"](query_all$27dom("[data-photo]")), function (card) {
        return on$27dom(card, click$27dom, function (e) {
          let id$27387;
          if (plain_click$3f$27dom(e)) {
            (id$27387 = data_of$27dom(card, "photo"));
            prevent_default$21$27dom(e);
            set_attribute$21$27dom(by_id$27dom("photo-dialog-img"), "src", $B["string-append"]("/photo/", id$27387));
            set_text$21$27dom(by_id$27dom("photo-dialog-date"), data_of$27dom(card, "date"));
            set_field$21$27dom(by_id$27dom("photo-dialog-caption"), data_of$27dom(card, "caption"));
            place_pin$27photos(data_of$27dom(card, "place"));
            set_attribute$21$27dom(by_id$27dom("photo-dialog-form"), "action", $B["string-append"]("/photos/", id$27387));
            return show_modal$21$27dom(d$27386);
          } else {
            return false;
          }
        });
      });
      ((pin$27388 = by_id$27dom("photo-dialog-place")), ((pin$27388) !== false ? (place_pin$27photos(data_of$27dom(pin$27388, "place")), on$27dom(pin$27388, click$27dom, function (e) {
        set_field$21$27dom(by_id$27dom("photo-dialog-caption"), data_of$27dom(pin$27388, "place"));
        return focus$21$27dom(by_id$27dom("photo-dialog-caption"));
      })) : false));
      ((cancel$27389 = query$27dom("[data-photo-cancel]")), (delete$27390 = query$27dom("[data-photo-delete]")), ((cancel$27389) !== false ? on$27dom(cancel$27389, click$27dom, function (e) {
        prevent_default$21$27dom(e);
        return close_dialog$21$27dom(d$27386);
      }) : false), ((delete$27390) !== false ? on$27dom(delete$27390, click$27dom, function (e) {
        if (confirmed$3f$27page("Delete this photo? Its original goes too.")) {
          return false;
        } else {
          return prevent_default$21$27dom(e);
        }
      }) : false));
      return on$27dom(d$27386, click$27dom, function (e) {
        if ((closest_of$27dom(e, "#photo-dialog img, #photo-dialog form")) !== false) {
          return false;
        } else {
          return close_dialog$21$27dom(d$27386);
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
    let end$27402, front$27395, handler$27i254, handler$27i255, load_photos$27403, next_photo$27398, order$27394, photos$27393, saver$27391, show$27400, showing$27397, start$27401, texts$27399, timer$27396, wait$27392;
    (saver$27391 = by_id$27dom("saver"));
    (wait$27392 = by_id$27dom("ready-wait"));
    (photos$27393 = $B["vector"]());
    (order$27394 = null);
    (front$27395 = false);
    (timer$27396 = 0);
    (showing$27397 = false);
    (next_photo$27398 = function () {
      let i$27404, p$27405;
      ($B["null?"](order$27394) ? (order$27394 = $B["vector->list"](photos$27393)) : false);
      (i$27404 = $B["exact"]($B["floor"]((random$27page() * $B["length"](order$27394)))));
      (p$27405 = nth$27saver(order$27394, i$27404));
      (order$27394 = without$27saver(order$27394, i$27404));
      return p$27405;
    });
    (texts$27399 = function (p) {
      set_text$21$27dom(by_id$27dom("saver-caption"), $B["map-ref"](p, "caption", ""));
      return set_text$21$27dom(by_id$27dom("saver-date"), $B["map-ref"](p, "date", ""));
    });
    (show$27400 = function (p) {
      let back$27409, begin_moving$27414, coming$27406, from$27412, going$27407, img$27408, scale$27i248, scale$27i251, to$27413, url$27410, x$27i249, x$27i252, y$27i250, y$27i253, zoom_in$27411;
      (coming$27406 = by_id$27dom(($B["equal?"](front$27395, "saver-a") ? "saver-b" : "saver-a")));
      (going$27407 = ((front$27395) !== false ? by_id$27dom(front$27395) : false));
      (img$27408 = query_in$27dom(coming$27406, "img"));
      (back$27409 = query_in$27dom(coming$27406, ".saver-back"));
      (url$27410 = $B["string-append"]("/photo/", $B["number->string"]($B["map-ref"](p, "id", 0))));
      (zoom_in$27411 = (random$27page() < 0.5));
      (from$27412 = ((scale$27i248 = (zoom_in$27411 ? 1.0 : 1.1000000000000001)), (x$27i249 = (-2.0 + ((2.0 - -2.0) * random$27page()))), (y$27i250 = (-2.0 + ((2.0 - -2.0) * random$27page()))), $B["string-append"]("scale(", $realText(scale$27i248), ") translate(", $B["string-append"]($realText(($B["round"]((x$27i249 * 100.0)) / 100.0)), "%"), ", ", $B["string-append"]($realText(($B["round"]((y$27i250 * 100.0)) / 100.0)), "%"), ")")));
      (to$27413 = ((scale$27i251 = (zoom_in$27411 ? 1.1000000000000001 : 1.0)), (x$27i252 = (-2.0 + ((2.0 - -2.0) * random$27page()))), (y$27i253 = (-2.0 + ((2.0 - -2.0) * random$27page()))), $B["string-append"]("scale(", $realText(scale$27i251), ") translate(", $B["string-append"]($realText(($B["round"]((x$27i252 * 100.0)) / 100.0)), "%"), ", ", $B["string-append"]($realText(($B["round"]((y$27i253 * 100.0)) / 100.0)), "%"), ")")));
      (begin_moving$27414 = function () {
        set_style$21$27dom(coming$27406, "transition", "none");
        set_style$21$27dom(coming$27406, "transform", from$27412);
        set_style$21$27dom(coming$27406, "opacity", "0");
        after$27page(50, function () {
          set_style$21$27dom(coming$27406, "transition", "transform 11.5s linear, opacity 1.5s ease");
          set_style$21$27dom(coming$27406, "transform", to$27413);
          set_style$21$27dom(coming$27406, "opacity", "1");
          texts$27399(p);
          if ((going$27407) !== false) {
            return set_style$21$27dom(going$27407, "opacity", "0");
          } else {
            return false;
          }
        });
        (front$27395 = id_of$27dom(coming$27406));
        return (timer$27396 = after$27page(shown_ms$27saver, function () {
          if ((showing$27397) !== false) {
            return show$27400(next_photo$27398());
          } else {
            return false;
          }
        }));
      });
      on_once$27dom(img$27408, load$27dom, function (e) {
        if ((showing$27397) !== false) {
          return begin_moving$27414();
        } else {
          return false;
        }
      });
      set_style$21$27dom(back$27409, "background-image", $B["string-append"]("url(", url$27410, ")"));
      return set_attribute$21$27dom(img$27408, "src", url$27410);
    });
    (start$27401 = function () {
      (showing$27397 = true);
      set_text$21$27dom(by_id$27dom("saver-name"), $B["map-ref"](self$27socket, "name", ""));
      set_hidden$21$27dom(saver$27391, false);
      return show$27400(next_photo$27398());
    });
    (end$27402 = function () {
      (showing$27397 = false);
      cancel_timer$21$27page(timer$27396);
      return set_hidden$21$27dom(saver$27391, true);
    });
    (load_photos$27403 = function () {
      return fetch_text$27fetch("/photos.json", function (status, body$27dom) {
        let l$27415;
        (l$27415 = ((status === 200) ? $B["json-parse"](body$27dom, false) : false));
        if ($B["vector?"](l$27415)) {
          (photos$27393 = l$27415);
          (order$27394 = null);
          if (((showing$27397) !== false ? ($B["vector-length"](l$27415) === 0) : false)) {
            return end$27402();
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
    });
    if ((((saver$27391) !== false ? wait$27392 : false)) !== false) {
      load_photos$27403();
      ((handler$27i254 = function (text, m) {
        return load_photos$27403();
      }), (handlers$27socket = $B["map-set"](handlers$27socket, "photos", $B["append"]($B["map-ref"](handlers$27socket, "photos", null), $listFromEnd(handler$27i254)))));
      ((handler$27i255 = function (text, m) {
        return set_text$21$27dom(by_id$27dom("saver-name"), $B["map-ref"](self$27socket, "name", ""));
      }), (handlers$27socket = $B["map-set"](handlers$27socket, "you", $B["append"]($B["map-ref"](handlers$27socket, "you", null), $listFromEnd(handler$27i255)))));
      return every$27page(1000, function () {
        let want$27416;
        (want$27416 = ((hidden$3f$27dom(wait$27392) === false) ? ($B["vector-length"](photos$27393) > 0) : false));
        if ((want$27416 ? (showing$27397 === false) : false)) {
          return start$27401();
        } else {
          if (((showing$27397) !== false ? (want$27416 === false) : false)) {
            return end$27402();
          } else {
            return false;
          }
        }
      });
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
});
