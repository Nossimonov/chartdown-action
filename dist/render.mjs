// packages/action/src/render.ts
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// packages/core/src/diagnostics.ts
var error = (line, message) => ({
  severity: "error",
  line,
  message
});
var warning = (line, message) => ({
  severity: "warning",
  line,
  message
});

// packages/core/src/lex.ts
function splitLines(source) {
  const out = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]);
    if (stripped.trim() === "") continue;
    out.push({
      indent: stripped.length - stripped.trimStart().length,
      text: stripped.trim(),
      line: i + 1
    });
  }
  return out;
}
function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    else if (ch === ";" && !inString) return line.slice(0, i);
  }
  return line;
}
function tokenize(text2, line, diagnostics) {
  const chunks = [];
  let current = "";
  let inString = false;
  for (const ch of text2) {
    if (ch === '"') {
      inString = !inString;
      current += ch;
    } else if (!inString && /\s/.test(ch)) {
      if (current) {
        chunks.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (inString) diagnostics.push(error(line, "unterminated string"));
  if (current) chunks.push(current);
  const tokens = [];
  for (const chunk of chunks) {
    if (chunk === ":") {
      tokens.push({ kind: "colon" });
      continue;
    }
    if (chunk.endsWith(":") && chunk.length > 1 && !chunk.includes("=") && !chunk.includes('"')) {
      tokens.push({ kind: "chunk", text: chunk.slice(0, -1) });
      tokens.push({ kind: "colon" });
      continue;
    }
    if (chunk.startsWith('"')) {
      tokens.push({ kind: "string", value: chunk.replace(/^"|"$/g, "") });
      continue;
    }
    const eq = chunk.indexOf("=");
    if (eq > 0 && !chunk.startsWith("(")) {
      const key = chunk.slice(0, eq);
      let value = chunk.slice(eq + 1);
      if (value.startsWith('"')) value = value.replace(/^"|"$/g, "");
      tokens.push({ kind: "pair", key, value });
      continue;
    }
    tokens.push({ kind: "chunk", text: chunk });
  }
  return tokens;
}

// packages/core/src/placements.ts
var ADDRESS_RE = /^([A-Z]+)(\d+)$/;
var RANGE_RE = /^([A-Z]+\d+)\.\.([A-Z]+\d+)$/;
var EDGE_RE = /^([A-Z]+\d+)\.(ne|nw|se|sw|n|e|s|w)$/;
var POINT_RE = /^\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)$/;
var POINT_RANGE_RE = /^(\(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\))\.\.(\(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\))$/;
var MEASURE_RE = /^\d+(?:\.\d+)?[a-z]*$/;
var COMPASS = /* @__PURE__ */ new Set([
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
  "north",
  "south",
  "east",
  "west",
  "northeast",
  "northwest",
  "southeast",
  "southwest"
]);
var SHAPES = /* @__PURE__ */ new Set(["area", "path", "blob", "ridge"]);
var RELATIONAL_KEYWORDS = /* @__PURE__ */ new Set(["at", "on", "near", "of", "from", "via", "to", "along", "edge"]);
function parseAddress(text2) {
  const m = ADDRESS_RE.exec(text2);
  return m ? { kind: "address", col: m[1], row: Number(m[2]) } : null;
}
var colToNumber = (letters) => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};
var numberToCol = (n) => {
  let out = "";
  let v = n;
  while (v > 0) {
    const r = (v - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out;
};
var REPEAT_LIMIT = 4096;
function expandRepeat(range, stepX, stepY) {
  const c0 = Math.min(colToNumber(range.from.col), colToNumber(range.to.col));
  const c1 = Math.max(colToNumber(range.from.col), colToNumber(range.to.col));
  const r0 = Math.min(range.from.row, range.to.row);
  const r1 = Math.max(range.from.row, range.to.row);
  const out = [];
  for (let r = r0; r <= r1; r += stepY) {
    for (let c = c0; c <= c1; c += stepX) {
      out.push({ kind: "address", col: numberToCol(c), row: r });
      if (out.length > REPEAT_LIMIT) return out;
    }
  }
  return out;
}
function parsePositional(text2) {
  const range = RANGE_RE.exec(text2);
  if (range) {
    return { kind: "range", from: parseAddress(range[1]), to: parseAddress(range[2]) };
  }
  const edge = EDGE_RE.exec(text2);
  if (edge) {
    return { kind: "edge", at: parseAddress(edge[1]), dir: edge[2] };
  }
  const address = parseAddress(text2);
  if (address) return address;
  const pointRange = POINT_RANGE_RE.exec(text2);
  if (pointRange) {
    return { kind: "point-range", from: parsePoint(pointRange[1]), to: parsePoint(pointRange[2]) };
  }
  return parsePoint(text2);
}
function parsePoint(text2) {
  const m = POINT_RE.exec(text2);
  return m ? { kind: "point", x: Number(m[1]), y: Number(m[2]) } : null;
}
function parseControl(text2) {
  const at = text2.indexOf("@");
  if (at < 0) return parsePoint(text2);
  const point = parsePoint(text2.slice(0, at));
  const width = text2.slice(at + 1);
  return point && MEASURE_RE.test(width) ? { ...point, width } : null;
}
var isCompass = (word) => COMPASS.has(word);
var isMeasure = (word) => MEASURE_RE.test(word);
function parsePredicate(tokens, line, diagnostics) {
  const result = { placements: [], flags: [], pairs: [], texts: [], refs: [] };
  let i = 0;
  const peek = (offset = 0) => tokens[i + offset];
  const chunkText = (t) => t?.kind === "chunk" ? t.text : null;
  const takeRef = (context) => {
    const t = tokens[i];
    if (t?.kind === "string") {
      i++;
      const ref = { kind: "ref", form: "name", value: t.value };
      result.refs.push(ref);
      return ref;
    }
    if (t?.kind === "chunk" && !RELATIONAL_KEYWORDS.has(t.text) && !parsePositional(t.text)) {
      i++;
      const ref = { kind: "ref", form: "id", value: t.text };
      result.refs.push(ref);
      return ref;
    }
    diagnostics.push(error(line, `expected a reference after '${context}'`));
    return null;
  };
  const takeAlongFace = () => {
    const a = chunkText(peek());
    if (a && isCompass(a) && chunkText(peek(1)) === "edge" && chunkText(peek(2)) === "of") {
      i += 3;
      return a;
    }
    return void 0;
  };
  const takeRepeat = () => {
    const stepText = chunkText(peek());
    const m = stepText ? /^(\d+)(?:x(\d+))?$/.exec(stepText) : null;
    if (!m) {
      diagnostics.push(error(line, "'every' takes a whole-number step: 'every 4 in <range>', or 'every 4x6 in <range>' for independent column and row steps (spec 02 \xA79)"));
      return null;
    }
    const stepX = Number(m[1]);
    const stepY = m[2] === void 0 ? stepX : Number(m[2]);
    i++;
    if (stepX < 1 || stepY < 1) {
      diagnostics.push(error(line, "'every' steps by at least 1 cell (spec 02 \xA79)"));
      return null;
    }
    const kw = chunkText(peek());
    if (kw !== "in") {
      diagnostics.push(error(line, kw === "along" ? "'every \u2026 along <ref>' spaces by a MEASURE, not a count \u2014 'every 6ft along gallery' (spec 02 \xA79)" : "'every <n>' is followed by 'in <range>' (spec 02 \xA79)"));
      return null;
    }
    i++;
    const rangeText = chunkText(peek());
    const range = rangeText ? parsePositional(rangeText) : null;
    if (!range || range.kind !== "range") {
      const edgeish = rangeText !== null && /^[A-Z]+\d+\.(ne|nw|se|sw|n|e|s|w)\.\./.test(rangeText);
      diagnostics.push(error(line, edgeish ? "'every' steps over CELLS, not edges \u2014 name the side instead ('cave-in : east' replaces that whole run, spec 06 \xA73), or list the edges (spec 02 \xA79)" : "expected a cell range after 'in', e.g. 'every 4 in FH38..GF102' (spec 02 \xA79)"));
      return null;
    }
    i++;
    const cells = expandRepeat(range, stepX, stepY);
    if (cells.length > REPEAT_LIMIT) {
      diagnostics.push(error(line, `'every ${stepText} in ${rangeText}' expands past ${REPEAT_LIMIT} cells \u2014 narrow the range or widen the step (spec 02 \xA79)`));
      return null;
    }
    return cells;
  };
  const takeEndpoint = () => {
    const t = tokens[i];
    if (t?.kind === "chunk") {
      const point = parsePoint(t.text);
      if (point) {
        i++;
        return { at: point };
      }
    }
    const ref = takeRef("from/to");
    if (!ref) return null;
    if (chunkText(peek()) === "at") {
      i++;
      const pt = chunkText(peek());
      const point = pt ? parsePoint(pt) : null;
      if (!point) {
        diagnostics.push(error(line, "expected a point after 'at' in a path endpoint"));
        return { at: ref };
      }
      i++;
      return { at: ref, point };
    }
    return { at: ref };
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === "pair") {
      result.pairs.push({ key: t.key, value: t.value });
      i++;
      continue;
    }
    if (t.kind === "string") {
      result.texts.push(t.value);
      i++;
      continue;
    }
    if (t.kind === "colon") {
      diagnostics.push(error(line, "unexpected ':' in predicate"));
      i++;
      continue;
    }
    const c = t.text;
    if (SHAPES.has(c)) {
      i++;
      let frame;
      if (chunkText(peek()) === "on") {
        i++;
        const ref = takeRef("on");
        if (!ref) continue;
        if (chunkText(peek()) !== "at") {
          diagnostics.push(error(line, `'${c} on ${ref.value}' needs 'at' and the offsets that follow it \u2014 '${c} on ${ref.value} at (-70,100) (-90,170)' (spec 02 \xA79)`));
          continue;
        }
        i++;
        frame = ref;
      }
      const args = [];
      while (i < tokens.length) {
        const next = tokens[i];
        if (c === "area" && (next.kind === "chunk" && next.text === "along")) {
          i++;
          const face = takeAlongFace();
          const ref = takeRef("along");
          if (ref) args.push(face ? { kind: "relational", form: "along", ref, face } : { kind: "relational", form: "along", ref });
          continue;
        }
        if (next.kind !== "chunk") break;
        const pos = parsePositional(next.text);
        if (!pos) break;
        args.push(pos);
        i++;
      }
      result.placements.push(frame ? { kind: "shape", shape: c, args, frame } : { kind: "shape", shape: c, args });
      continue;
    }
    if (c === "every") {
      i++;
      const stepText = chunkText(peek());
      if (stepText !== null && isMeasure(stepText) && chunkText(peek(1)) === "along") {
        i += 2;
        const ref = takeRef("along");
        if (!ref) continue;
        result.placements.push({ kind: "relational", form: "every-along", measure: stepText, ref });
        continue;
      }
      const cells = takeRepeat();
      if (cells === null) continue;
      result.placements.push(...cells);
      continue;
    }
    if (c === "at") {
      i++;
      const targetText = chunkText(peek());
      const target = targetText ? parsePositional(targetText) : null;
      if (!target || target.kind === "point-range") {
        diagnostics.push(error(line, "expected a point, cell, range, or edge after 'at'"));
        continue;
      }
      i++;
      result.placements.push({ kind: "relational", form: "at", target });
      continue;
    }
    if (c === "on") {
      i++;
      const ref = takeRef("on");
      if (!ref) continue;
      let point;
      let at;
      if (chunkText(peek()) === "at" && chunkText(peek(1)) === "every") {
        i += 2;
        const cells = takeRepeat();
        if (cells === null) continue;
        for (const cell of cells) result.placements.push({ kind: "relational", form: "on", ref, at: cell });
        continue;
      }
      if (chunkText(peek()) === "at") {
        const after = chunkText(peek(1));
        const parsed = after ? parsePositional(after) : null;
        if (parsed?.kind === "point") {
          point = parsed;
          i += 2;
        } else if (parsed && parsed.kind !== "point-range") {
          at = parsed;
          i += 2;
        }
      }
      const via = [];
      if (point && chunkText(peek()) === "via") {
        i++;
        for (; ; ) {
          const text2 = chunkText(peek());
          const next = text2 ? parseControl(text2) : null;
          if (!next) break;
          via.push(next);
          i++;
        }
        if (via.length === 0) {
          diagnostics.push(error(line, `'via' on '${ref.value}' has no points \u2014 a centerline needs at least one (spec 05 \xA74)`));
        }
      }
      result.placements.push(
        point && via.length > 0 ? { kind: "relational", form: "on", ref, point, via } : point ? { kind: "relational", form: "on", ref, point } : at ? { kind: "relational", form: "on", ref, at } : { kind: "relational", form: "on", ref }
      );
      continue;
    }
    if (c === "near") {
      i++;
      const nextText = chunkText(peek());
      const point = nextText ? parsePoint(nextText) : null;
      if (point) {
        i++;
        result.placements.push({ kind: "relational", form: "near", target: point });
        continue;
      }
      const ref = takeRef("near");
      if (ref) result.placements.push({ kind: "relational", form: "near", target: ref });
      continue;
    }
    if (c === "along") {
      i++;
      const face = takeAlongFace();
      const ref = takeRef("along");
      if (ref) result.placements.push(face ? { kind: "relational", form: "along", ref, face } : { kind: "relational", form: "along", ref });
      continue;
    }
    if (c === "from") {
      i++;
      const from = takeEndpoint();
      if (!from) continue;
      const via = [];
      if (chunkText(peek()) === "via") {
        i++;
        while (i < tokens.length) {
          const pt = chunkText(peek());
          const point = pt ? parsePoint(pt) : null;
          if (!point) break;
          via.push(point);
          i++;
        }
        if (via.length === 0) diagnostics.push(error(line, "expected at least one point after 'via'"));
      }
      const terminal = chunkText(peek());
      if (terminal !== "to" && terminal !== "join") {
        diagnostics.push(error(line, "expected 'to' or 'join' in from\u2026to placement (spec 02 \xA77)"));
        continue;
      }
      i++;
      const to = takeEndpoint();
      if (!to) continue;
      if (terminal === "join") {
        if (to.at.kind !== "ref") {
          diagnostics.push(error(line, "'join' takes the watercourse to end on, not a position \u2014 'join mitheithel' (spec 02 \xA77)"));
          continue;
        }
        if (to.point) {
          diagnostics.push(error(line, "'join <ref>' finds the meeting point itself; drop the 'at <point>' (spec 02 \xA77)"));
          continue;
        }
        to.join = true;
      }
      result.placements.push({ kind: "relational", form: "from-to", from, via, to });
      continue;
    }
    if (isMeasure(c) && isCompass(chunkText(peek(1)) ?? "") && chunkText(peek(2)) === "of") {
      const compass = chunkText(peek(1));
      i += 3;
      const ref = takeRef("of");
      if (ref) result.placements.push({ kind: "relational", form: "offset-of", measure: c, compass, ref });
      continue;
    }
    if (isCompass(c)) {
      if (chunkText(peek(1)) === "edge" && chunkText(peek(2)) === "of") {
        i += 3;
        const ref = takeRef("edge of");
        if (ref) result.placements.push({ kind: "relational", form: "edge-of", compass: c, ref });
        continue;
      }
      if (chunkText(peek(1)) === "of") {
        i += 2;
        const ref = takeRef("of");
        if (ref) result.placements.push({ kind: "relational", form: "side-of", compass: c, ref });
        continue;
      }
      result.flags.push(c);
      i++;
      continue;
    }
    const positional = parsePositional(c);
    if (positional) {
      result.placements.push(positional);
      i++;
      continue;
    }
    if (RELATIONAL_KEYWORDS.has(c)) {
      diagnostics.push(error(line, `misplaced relational keyword '${c}' \u2014 the closed placement grammar defines only the nine forms of spec 02 \xA77`));
      i++;
      continue;
    }
    result.flags.push(c);
    i++;
  }
  return result;
}

// packages/core/src/vocab.ts
var CLOSED_FACETS = {
  passes: /* @__PURE__ */ new Set(["open", "closed", "none"]),
  sight: /* @__PURE__ */ new Set(["all", "none"]),
  // How a placed morphology feature relates to the line it sits on (spec 05
  // §4, ADR 0023). The WORD says what a thing is and how it is coloured; this
  // says what its geometry does to the host — so `bay` and `cove` both bite,
  // and `island` and `oxbow` are both detached while being land and water.
  morph: /* @__PURE__ */ new Set(["jut", "bite", "detached"])
};
var facetAccepts = (key, value) => CLOSED_FACETS[key]?.has(value) ?? true;
function checkFacetValues(pairs, line, diagnostics) {
  for (const p of pairs) {
    const allowed = CLOSED_FACETS[p.key];
    if (!allowed || allowed.has(p.value)) continue;
    diagnostics.push(
      warning(line, `'${p.key}=${p.value}' is not one of ${[...allowed].join(", ")} \u2014 the vocabulary default applies (spec 04 \xA71)`)
    );
  }
}
var ARCHETYPES = /* @__PURE__ */ new Set([
  "terrain",
  "path",
  "feature",
  "structure",
  "barrier",
  "opening",
  "token",
  "zone",
  "field"
]);
var STDLIB_SOURCE = `# Chartdown Standard Library

[vocab]
; terrain (spec 05)
sea : terrain
lake : terrain
plains : terrain
grassland : terrain
farmland : terrain
forest : terrain
jungle : terrain
hills : terrain
mountains : terrain
peak : terrain
volcano : peak states=dormant,erupting
marsh : terrain states=difficult
desert : terrain
dunes : desert
snowfield : terrain
tundra : terrain
wasteland : terrain

; linear features
river : path
stream : river width=1
road : path
trail : road
canal : river
pass : path
coastline : path

; placed morphology (spec 05 \xA74, ADR 0023) \u2014 discrete features ON a line, each
; a real addressable entity rather than generated noise. \`morph=\` says what the
; geometry does to the host line; the word says what the thing IS, which is what
; a theme colours, so a bite can be water and a jut can be land. \`reach=\` is
; depth as a multiple of mouth width and \`taper=\` is how much of the mouth is
; spent narrowing \u2014 calibrated against Puget Sound (#161), where the measured
; ratios run from Point No Point at 0.33 to Hood Canal at 27.
cape : terrain morph=jut reach=0.55
headland : cape
peninsula : cape reach=1.6
spit : cape reach=5 taper=0.5
bay : terrain morph=bite reach=1
cove : bay reach=3 taper=0.7
sound : bay reach=6 taper=0.4
fjord : sound reach=20 taper=0.15
island : terrain morph=detached
islet : island
atoll : island
oxbow : terrain morph=detached

; crossings
ford : feature states=difficult
bridge : feature

; settlements
settlement : feature
capital : settlement
city : settlement
town : settlement
village : settlement
hamlet : village

; sites
keep : feature
castle : keep
tower : feature
ruin : feature
dungeon : feature
lair : feature
camp : feature
mine : feature
shrine : feature
temple : shrine
port : feature
cave : feature
landmark : feature

; zones
realm : zone
region : zone
border : zone

; annotation (spec 07)
note : feature

; battlemap (spec 06)
building : structure states=ruined
wall : barrier states=ruined
fence : barrier sight=all
pillar : barrier
door : opening passes=closed sight=none states=locked,barred,stuck,ruined
gate : door
window : opening passes=none sight=all
arrow-slit : window
stairs : feature
mud : terrain states=difficult
sand : terrain
grass : terrain
snow : terrain
ice : terrain states=difficult
water : terrain states=difficult
rubble : terrain states=difficult
ramp : feature
slope : terrain
earth : terrain
terrace : terrain
roof : terrain
air : terrain
void : air
wagon : feature states=overturned
crates : feature
barrel : feature
chest : feature
table : feature
altar : feature
statue : feature
well : feature
boulder : feature
tree : feature
pit : feature states=difficult
campfire : feature light=20ft
torch : feature light=20ft
lantern : feature light=15ft
brazier : feature light=20ft
start : zone

; fields \u2014 emanate from sources over an ambient baseline (spec 04 \xA76)
light : field states=dark,dim,daylight,moonlight
`;
var VocabTable = class {
  entries = /* @__PURE__ */ new Map();
  add(entry, diagnostics) {
    if (!entry.baseIsArchetype) {
      const seen = /* @__PURE__ */ new Set([entry.word]);
      let base = entry.base;
      while (base !== void 0 && !ARCHETYPES.has(base)) {
        if (seen.has(base)) {
          diagnostics.push(error(entry.line, `vocabulary cycle: '${entry.word}' derives (transitively) from itself`));
          return;
        }
        seen.add(base);
        const next = this.entries.get(base);
        if (!next) {
          diagnostics.push(
            error(entry.line, `'${entry.word}' derives from unknown word '${base}' \u2014 derivation bases must already exist (stdlib, use: library, or an earlier [vocab] line)`)
          );
          return;
        }
        base = next.baseIsArchetype ? void 0 : next.base;
      }
    }
    this.entries.set(entry.word, entry);
  }
  /** Resolve a word to its archetype through the derivation chain, or null if unknown. */
  archetypeOf(word) {
    let current = this.entries.get(word);
    while (current) {
      if (current.baseIsArchetype) return current.base;
      current = this.entries.get(current.base);
    }
    return null;
  }
  /**
   * The derivation chain for theme fallback (spec 04 §4): the word itself,
   * then each base word, ending before the archetype. `licorice-forest` →
   * ["licorice-forest", "forest"] — a theme walks it until a word it knows.
   */
  chain(word) {
    const out = [word];
    let current = this.entries.get(word);
    while (current && !current.baseIsArchetype) {
      out.push(current.base);
      current = this.entries.get(current.base);
    }
    return out;
  }
  has(word) {
    return this.entries.has(word);
  }
  /**
   * Declared states for a word, **unioned along the derivation chain** (spec
   * 04 §2): `hovercart : wagon states=parked` is parked OR overturned, because
   * derivation carries states exactly as it carries facets (ADR 0016).
   */
  statesOf(word) {
    const out = /* @__PURE__ */ new Set();
    const seen = /* @__PURE__ */ new Set();
    let current = this.entries.get(word);
    while (current && !seen.has(current.word)) {
      seen.add(current.word);
      const declared2 = current.pairs.find((p) => p.key === "states")?.value;
      if (declared2) for (const s of declared2.split(",").map((v) => v.trim()).filter(Boolean)) out.add(s);
      if (current.baseIsArchetype) break;
      current = this.entries.get(current.base);
    }
    return out;
  }
  /**
   * First facet pair for `key` along the derivation chain — vocabulary facets
   * are overridable defaults (spec 06 §2: `campfire : feature light=20ft`
   * means every campfire glows unless the entity says otherwise).
   */
  /**
   * Every facet key a word declares, unioned along its derivation chain (#195).
   *
   * The set a pair may legitimately override. Unioned rather than resolved,
   * because `fjord : sound reach=20 taper=0.15` inherits `morph=` from `bay`
   * without restating it, and an entity may override any of the three.
   */
  facetKeysOf(word) {
    const out = /* @__PURE__ */ new Set();
    const seen = /* @__PURE__ */ new Set();
    let current = this.entries.get(word);
    while (current && !seen.has(current.word)) {
      seen.add(current.word);
      for (const pair of current.pairs) out.add(pair.key);
      if (current.baseIsArchetype) break;
      current = this.entries.get(current.base);
    }
    return out;
  }
  /**
   * Words that are FIELDS, whose name is itself a parameter (spec 04 §5).
   *
   * Declaring `radiation : field` is what makes `radiation=40ft` mean something
   * on an emitter — the parameter namespace is derived from the vocabulary
   * rather than fixed, so it cannot be checked against a static list.
   */
  fieldWords() {
    const out = /* @__PURE__ */ new Set();
    for (const word of this.entries.keys()) {
      if (this.archetypeOf(word) === "field") out.add(word);
    }
    return out;
  }
  /**
   * A word's facet value, walking the derivation chain (spec 04 §2).
   *
   * A value outside a closed set is SKIPPED rather than returned, so the walk
   * continues to the next word up (#131). That is what "the vocabulary default
   * applies" has to mean on a chain: for `mydoor : door passes=bogus`, the
   * default is `door`'s `closed`, not the archetype's `open` — dropping all
   * the way to the built-in would silently reopen every derived door.
   */
  facetOf(word, key) {
    let current = this.entries.get(word);
    while (current) {
      const pair = current.pairs.find((p) => p.key === key);
      if (pair && facetAccepts(key, pair.value)) return pair.value;
      if (current.baseIsArchetype) return void 0;
      current = this.entries.get(current.base);
    }
    return void 0;
  }
};
function parseVocabLine(text2, line, source, diagnostics) {
  const tokens = tokenize(text2, line, diagnostics);
  const [first, second, third] = [tokens[0], tokens[1], tokens[2]];
  if (first?.kind !== "chunk" || second?.kind !== "colon" || third?.kind !== "chunk") {
    diagnostics.push(error(line, "malformed [vocab] line \u2014 expected 'word : archetype-or-word'"));
    return null;
  }
  const pairs = [];
  const flags = [];
  for (const t of tokens.slice(3)) {
    if (t.kind === "pair") pairs.push({ key: t.key, value: t.value });
    else if (t.kind === "chunk") flags.push(t.text);
    else diagnostics.push(error(line, "unexpected token in [vocab] line"));
  }
  checkFacetValues(pairs, line, diagnostics);
  return {
    kind: "vocab-entry",
    word: first.text,
    base: third.text,
    baseIsArchetype: ARCHETYPES.has(third.text),
    pairs,
    flags,
    source,
    line
  };
}
function parseVocabDocument(source, origin, table, diagnostics) {
  const added = [];
  let inVocab = false;
  for (const raw of splitLines(source)) {
    if (raw.text.startsWith("#")) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(raw.text);
    if (sectionMatch) {
      inVocab = sectionMatch[1] === "vocab";
      if (!inVocab) diagnostics.push(warning(raw.line, `vocabulary document: ignoring non-vocab section [${sectionMatch[1]}]`));
      continue;
    }
    if (!inVocab) continue;
    const entry = parseVocabLine(raw.text, raw.line, origin, diagnostics);
    if (entry) {
      table.add(entry, diagnostics);
      added.push(entry);
    }
  }
  return added;
}
function loadStdlib(table) {
  const scratch = [];
  parseVocabDocument(STDLIB_SOURCE, "stdlib", table, scratch);
  if (scratch.some((d) => d.severity === "error")) {
    throw new Error(`@chartdown/core: standard library failed to parse: ${scratch[0].message}`);
  }
}
var SECTION_ARCHETYPE = {
  terrain: "terrain",
  water: "terrain",
  paths: "path",
  routes: "path",
  structures: "structure",
  features: "feature",
  settlements: "feature",
  tokens: "token",
  realms: "zone",
  regions: "zone"
};
function inferArchetype(placements, section) {
  for (const p of placements) {
    if (p.kind === "shape") {
      return {
        archetype: p.shape === "area" || p.shape === "blob" ? "terrain" : "path",
        source: "inferred-shape"
      };
    }
    if (p.kind === "relational" && p.form === "from-to") {
      return { archetype: "path", source: "inferred-shape" };
    }
  }
  const bySection = SECTION_ARCHETYPE[section];
  if (bySection) return { archetype: bySection, source: "inferred-section" };
  if (placements.length === 1 && (placements[0].kind === "point" || placements[0].kind === "address")) {
    return { archetype: "feature", source: "inferred-shape" };
  }
  return { archetype: "feature", source: "default" };
}

// packages/core/src/parse.ts
var SPEC_VERSION = "0.4";
var MAP_TYPES = /* @__PURE__ */ new Set(["battlemap", "hexcrawl", "region"]);
var KNOWN_HEADER_KEYS = /* @__PURE__ */ new Set([
  "map",
  "kind",
  "chartdown",
  "id",
  "grid",
  "scale",
  "extent",
  "seed",
  "use",
  "theme",
  "labels",
  "legend",
  "scale-bar",
  "compass",
  "numbers",
  "levels",
  "level",
  "ground",
  "detail",
  "inset"
]);
var DOCUMENT_KINDS = /* @__PURE__ */ new Set(["vocabulary", "theme"]);
var HEADER_FORMATS = {
  extent: { re: /^\d+x\d+[a-z]*$/, expected: "<width>x<height> with an optional unit, e.g. '900x600mi'" },
  seed: { re: /^-?\d+$/, expected: "a whole number, e.g. '3742'" },
  // Unit optional: grammar.ebnf defines `measure = number , [ unit ]`, so
  // `scale: 5` is grammar-legal and tightening it here would be a language
  // change smuggled in as a bug fix.
  scale: { re: /^\d+(\.\d+)?[a-z]*$/, expected: "a measure, e.g. '5ft' or '6mi'" },
  chartdown: { re: /^\d+(\.\d+)*$/, expected: "a spec version, e.g. '0.3'" }
};
var formatMessage = (key, value) => `'${key}: ${value}' is malformed \u2014 expected ${HEADER_FORMATS[key].expected} (spec 01 \xA72)`;
var CLOSED_HEADER_VALUES = {
  labels: /* @__PURE__ */ new Set(["names", "keyed", "none"]),
  detail: /* @__PURE__ */ new Set(["overview", "reference"]),
  legend: /* @__PURE__ */ new Set(["on", "off"]),
  "scale-bar": /* @__PURE__ */ new Set(["on", "off"]),
  compass: /* @__PURE__ */ new Set(["on", "off"]),
  numbers: /* @__PURE__ */ new Set(["on", "off"])
};
var UNIVERSAL_SECTIONS = /* @__PURE__ */ new Set(["vocab", "gm", "labels"]);
var SECTIONS_BY_TYPE = {
  battlemap: /* @__PURE__ */ new Set(["terrain", "structures", "features", "tokens"]),
  hexcrawl: /* @__PURE__ */ new Set(["hexes", "routes", "regions"]),
  region: /* @__PURE__ */ new Set(["water", "terrain", "paths", "settlements", "features", "realms"])
};
var RESERVED_FLAGS = /* @__PURE__ */ new Set([
  "hidden",
  "nolabel",
  "difficult",
  "seen",
  "unexplored",
  "drop",
  "open",
  "sprawl",
  "raw"
]);
function checkDeclaredStates(typeWord, flags, vocabTable, line, diagnostics) {
  if (typeWord === null || flags.length === 0) return;
  if (vocabTable.archetypeOf(typeWord) === null) return;
  if (vocabTable.chain(typeWord).includes("border")) return;
  const declared2 = vocabTable.statesOf(typeWord);
  for (const flag of flags) {
    if (RESERVED_FLAGS.has(flag) || declared2.has(flag)) continue;
    diagnostics.push(
      warning(line, `'${flag}' is not a declared state of '${typeWord}' \u2014 it still renders; declare it with states= to silence this (spec 04 \xA72)`)
    );
  }
}
var RESERVED_PAIRS = /* @__PURE__ */ new Set([
  "gm",
  "link",
  "detail",
  "detail-at",
  "facing",
  "size",
  "side",
  "width",
  "light",
  "elevation",
  "key",
  "level",
  "to",
  "through",
  "at"
]);
function checkPairKeys(typeWord, pairs, vocabTable, line, diagnostics) {
  if (typeWord === null || pairs.length === 0) return;
  if (vocabTable.archetypeOf(typeWord) === null) return;
  if (vocabTable.chain(typeWord).includes("border")) return;
  const facets = vocabTable.facetKeysOf(typeWord);
  const fields = vocabTable.fieldWords();
  const morph = vocabTable.facetOf(typeWord, "morph");
  if (morph === "jut" || morph === "bite") {
    facets.add("reach");
    facets.add("taper");
  } else if (morph === "detached") {
    facets.add("reach");
  }
  for (const pair of pairs) {
    if (RESERVED_PAIRS.has(pair.key) || facets.has(pair.key) || fields.has(pair.key)) continue;
    if (pair.key.startsWith("x-")) continue;
    diagnostics.push(
      warning(line, `'${pair.key}=' is not a parameter '${typeWord}' can use, so it is ignored \u2014 check the spelling, or give '${typeWord}' a ${pair.key}= facet in [vocab] (spec 04 \xA72)`)
    );
  }
}
function slugify(text2) {
  return text2.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
var SymbolTable = class {
  entries = [];
  byId = /* @__PURE__ */ new Map();
  add(ids, name, line, diagnostics) {
    const entry = { ids, name, index: this.entries.length, line };
    for (const id of ids) {
      const existing = this.byId.get(id);
      if (existing) {
        diagnostics.push(error(line, `duplicate explicit id '${id}' (first declared on line ${existing.line})`));
      } else {
        this.byId.set(id, entry);
      }
    }
    this.entries.push(entry);
  }
  /** Order-bounded resolution (spec 02 §8.1, spec 03 §2). Returns the entry or null with a diagnostic. */
  resolve(ref, line, diagnostics) {
    const bound = this.entries.length;
    if (ref.form === "id") {
      const entry = this.byId.get(ref.value);
      if (!entry) {
        diagnostics.push(error(line, `unresolved reference '${ref.value}' \u2014 no earlier entity has this id`));
        return null;
      }
      if (entry.index >= bound) {
        diagnostics.push(
          error(line, `forward reference '${ref.value}' (declared on line ${entry.line}) \u2014 references may only point to earlier declarations`)
        );
        return null;
      }
      return entry;
    }
    const matches = this.entries.filter((e) => e.name === ref.value);
    if (matches.length === 0) {
      diagnostics.push(error(line, `unresolved reference "${ref.value}" \u2014 no earlier entity has this display name`));
      return null;
    }
    if (matches.length > 1) {
      diagnostics.push(
        error(line, `ambiguous reference "${ref.value}" \u2014 matches entities on lines ${matches.map((m) => m.line).join(", ")}; give the intended one an explicit id`)
      );
      return null;
    }
    return matches[0];
  }
  /** Resolution without emitting diagnostics — used to classify [gm] lines. */
  tryResolve(ref) {
    if (ref.form === "id") return this.byId.get(ref.value) ?? null;
    const matches = this.entries.filter((e) => e.name === ref.value);
    return matches.length === 1 ? matches[0] : null;
  }
};
function parseSubject(tokens, line, diagnostics) {
  const parts = { typeWord: null, ids: [], name: null };
  for (const t of tokens) {
    if (t.kind === "chunk") {
      if (parts.name !== null) {
        diagnostics.push(error(line, "subject words must precede the display name"));
        continue;
      }
      if (parts.typeWord === null) parts.typeWord = t.text;
      else parts.ids.push(t.text);
    } else if (t.kind === "string") {
      if (parts.name !== null) diagnostics.push(error(line, "a subject may carry only one display name"));
      else parts.name = t.value;
    } else {
      diagnostics.push(error(line, "unexpected token in subject"));
    }
  }
  return parts;
}
function splitAtColon(tokens, line, diagnostics) {
  const idx = tokens.findIndex((t) => t.kind === "colon");
  if (idx === -1) {
    diagnostics.push(error(line, "expected 'subject : predicate'"));
    return null;
  }
  return { subject: tokens.slice(0, idx), predicate: tokens.slice(idx + 1) };
}
function parseGrid(value, line, diagnostics) {
  const words = value.split(/\s+/).filter(Boolean);
  const kind = words[0];
  const dims = /^(\d+)x(\d+)$/.exec(words[1] ?? "");
  if (kind !== "square" && kind !== "hex" || !dims) {
    diagnostics.push(error(line, "malformed grid: expected 'square WxH' or 'hex WxH <pointy|flat> <odd-row|even-row|odd-col|even-col>'"));
    return null;
  }
  const spec = { kind, cols: Number(dims[1]), rows: Number(dims[2]) };
  if (kind === "hex") {
    const orientation = words[2];
    const parity = words[3];
    if (orientation !== "pointy" && orientation !== "flat" || parity !== "odd-row" && parity !== "even-row" && parity !== "odd-col" && parity !== "even-col") {
      diagnostics.push(error(line, "hex grids must declare orientation (pointy|flat) and offset parity (odd-row|even-row|odd-col|even-col) \u2014 spec 02 \xA74"));
      return spec;
    }
    spec.orientation = orientation;
    spec.parity = parity;
  }
  return spec;
}
function reportDeadVocab(document, diagnostics) {
  if (document.mapType === "") return;
  const spent = /* @__PURE__ */ new Set();
  for (const h of document.header) {
    spent.add(h.key);
    for (const word of h.value.split(/[\s,]+/)) if (word) spent.add(word);
  }
  const declared2 = [];
  for (const section of document.sections) {
    for (const entry of section.entries) {
      if (entry.kind === "vocab-entry") {
        if (entry.source === "document") declared2.push(entry);
        spent.add(entry.base);
        continue;
      }
      if (entry.kind !== "entity") continue;
      if (entry.typeWord) spent.add(entry.typeWord);
      for (const d of entry.details) if (d.typeWord) spent.add(d.typeWord);
    }
  }
  for (const entry of declared2) {
    if (spent.has(entry.word)) continue;
    diagnostics.push(
      warning(
        entry.line,
        `'${entry.word}' is declared here and never used \u2014 nothing in this document carries the word or derives from it (spec 04 \xA73)`
      )
    );
  }
}
function parse(source, options = {}) {
  const diagnostics = [];
  const lines = splitLines(source);
  const vocab = new VocabTable();
  loadStdlib(vocab);
  const symbols = new SymbolTable();
  const document = {
    kind: "document",
    title: null,
    docId: "document",
    mapType: "",
    header: [],
    grid: null,
    levels: [],
    defaultLevel: "",
    importedVocab: [],
    sections: []
  };
  let i = 0;
  if (lines[i] && lines[i].text.startsWith("#")) {
    document.title = lines[i].text.replace(/^#+\s*/, "");
    i++;
  }
  let sawMap = false;
  let sawFirstHeader = false;
  let declaredKind = null;
  const deferredHeaderKeys = [];
  while (i < lines.length && !lines[i].text.startsWith("[")) {
    const raw = lines[i];
    const tokens = tokenize(raw.text, raw.line, diagnostics);
    const split = splitAtColon(tokens, raw.line, diagnostics);
    i++;
    if (!split) continue;
    const keyToken = split.subject[0];
    const qualifierToken = split.subject[1];
    if (split.subject.length > 2 || keyToken?.kind !== "chunk" || qualifierToken !== void 0 && qualifierToken.kind !== "chunk") {
      diagnostics.push(error(raw.line, "malformed header line \u2014 expected 'key: value' or 'key qualifier: value'"));
      continue;
    }
    const key = keyToken.text;
    const qualifier = qualifierToken !== void 0 && qualifierToken.kind === "chunk" ? qualifierToken.text : void 0;
    const value = split.predicate.map((t) => t.kind === "chunk" ? t.text : t.kind === "string" ? `"${t.value}"` : t.kind === "pair" ? `${t.key}=${t.value}` : ":").join(" ");
    document.header.push({ key, value, line: raw.line, ...qualifier !== void 0 ? { qualifier } : {} });
    if (!sawFirstHeader) {
      if (key !== "map" && key !== "kind") {
        diagnostics.push(error(raw.line, "the first header line is 'map:' or 'kind:' (spec 01 \xA72)"));
      }
      sawFirstHeader = true;
    }
    if (key === "kind") {
      declaredKind = value;
      if (!DOCUMENT_KINDS.has(value)) {
        diagnostics.push(error(raw.line, `unknown document kind '${value}' \u2014 expected vocabulary or theme (a map is spelled by 'map:')`));
      }
      if (sawMap) diagnostics.push(error(raw.line, "a document declares 'map:' or 'kind:', never both (spec 01 \xA72)"));
      continue;
    }
    if (key === "map") {
      if (declaredKind !== null) {
        diagnostics.push(error(raw.line, "a document declares 'map:' or 'kind:', never both (spec 01 \xA72)"));
      }
      sawMap = true;
    }
    if (key === "map") {
      document.mapType = value;
      if (!MAP_TYPES.has(value) && !value.endsWith("-beta")) {
        diagnostics.push(error(raw.line, `unknown map type '${value}' \u2014 expected battlemap, hexcrawl, or region`));
      }
    } else if (key === "grid") {
      document.grid = parseGrid(value, raw.line, diagnostics);
    } else if (key === "chartdown") {
      if (!HEADER_FORMATS.chartdown.re.test(value)) {
        diagnostics.push(error(raw.line, formatMessage("chartdown", value)));
      } else if (parseFloat(value) > parseFloat(SPEC_VERSION)) {
        diagnostics.push(warning(raw.line, `document targets spec ${value}; this parser implements ${SPEC_VERSION}`));
      }
    } else if (HEADER_FORMATS[key] !== void 0) {
      if (!HEADER_FORMATS[key].re.test(value)) {
        diagnostics.push(error(raw.line, formatMessage(key, value)));
      } else if (key === "extent" && /^0+x|x0+[a-z]*$/.test(value)) {
        diagnostics.push(error(raw.line, `'extent: ${value}' has a zero dimension \u2014 a map with no area renders nothing (spec 02 \xA75)`));
      }
    } else if (key === "use") {
      const lib = options.libraries?.[value];
      if (lib === void 0) {
        diagnostics.push(warning(raw.line, `library '${value}' not provided to the parser \u2014 its vocabulary is unavailable`));
      } else {
        document.importedVocab.push(...parseVocabDocument(lib, "library", vocab, diagnostics));
      }
    } else if (key === "id") {
      document.docId = value;
    } else if (key === "levels") {
      document.levels = value.split(/\s+/).filter(Boolean);
      if (document.levels.length < 2) diagnostics.push(error(raw.line, "levels: declares at least two levels, physical order topmost first (spec 06 \xA78)"));
    } else if (key === "level") {
      document.defaultLevel = value;
    } else if (CLOSED_HEADER_VALUES[key] !== void 0) {
      const allowed = CLOSED_HEADER_VALUES[key];
      if (!allowed.has(value)) {
        diagnostics.push(
          error(raw.line, `'${key}: ${value}' is not one of ${[...allowed].join(", ")} \u2014 the value is a closed set (spec 01 \xA72)`)
        );
      }
    } else if (!KNOWN_HEADER_KEYS.has(key)) {
      deferredHeaderKeys.push({ key, line: raw.line });
    }
  }
  const reportUnknownHeaderKeys = () => {
    for (const { key, line } of deferredHeaderKeys) {
      if (vocab.archetypeOf(key) === "field") continue;
      diagnostics.push(warning(line, `unknown header key '${key}'`));
    }
    for (const h of document.header) {
      if (h.key !== "detail" || document.mapType === "region") continue;
      diagnostics.push(
        warning(h.line, `'detail:' sets the render resolution of a gridless canvas and does nothing on a ${document.mapType} \u2014 its size comes from its grid (spec 02 \xA75)`)
      );
    }
    for (const h of document.header) {
      if (vocab.archetypeOf(h.key) !== "field") continue;
      const declared2 = vocab.statesOf(h.key);
      if (declared2.size === 0 || declared2.has(h.value)) continue;
      diagnostics.push(
        warning(h.line, `'${h.value}' is not a declared value of '${h.key}' \u2014 it still renders; declare it with states= to silence this (spec 04 \xA75)`)
      );
    }
  };
  if (!sawMap && declaredKind === null) {
    diagnostics.push(error(lines[0]?.line ?? 1, "missing required 'map:' header line"));
  }
  if (document.docId === "document" && document.title) document.docId = slugify(document.title);
  if (document.levels.length > 0) {
    if (document.defaultLevel === "") document.defaultLevel = document.levels[0];
    else if (!document.levels.includes(document.defaultLevel)) {
      diagnostics.push(error(document.header.find((h) => h.key === "level")?.line ?? 1, `default level '${document.defaultLevel}' is not declared in levels:`));
    }
  } else if (document.defaultLevel !== "") {
    diagnostics.push(error(document.header.find((h) => h.key === "level")?.line ?? 1, "level: requires a levels: declaration"));
  }
  const validLevel = (word) => document.levels.includes(word);
  const knownSections = SECTIONS_BY_TYPE[document.mapType] ?? /* @__PURE__ */ new Set();
  let section = null;
  let skippingUnknown = false;
  let lastEntity = null;
  const finishSection = () => {
    if (section) document.sections.push(section);
    section = null;
    lastEntity = null;
  };
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const sectionMatch = /^\[(.+)\]$/.exec(raw.text);
    if (sectionMatch) {
      finishSection();
      const words = sectionMatch[1].trim().split(/\s+/);
      const name = words[0];
      const qualifier = words[1] ?? null;
      if (words.length > 2) diagnostics.push(error(raw.line, "a section header takes at most one qualifier token (spec 01 \xA73)"));
      if (qualifier !== null) {
        if (document.levels.length === 0) {
          diagnostics.push(error(raw.line, `section qualifier '${qualifier}' requires a levels: declaration (spec 06 \xA78)`));
        } else if (!validLevel(qualifier)) {
          diagnostics.push(error(raw.line, `unknown level '${qualifier}' \u2014 declared levels: ${document.levels.join(" ")}`));
        }
      }
      const known = knownSections.has(name) || UNIVERSAL_SECTIONS.has(name);
      skippingUnknown = !known;
      if (!known && !name.startsWith("x-")) {
        diagnostics.push(warning(raw.line, `unknown section [${name}] \u2014 contents ignored`));
      }
      section = { kind: "section", name, level: qualifier, known, entries: [], line: raw.line };
      continue;
    }
    if (!section) {
      diagnostics.push(error(raw.line, "content before any [section]"));
      continue;
    }
    if (skippingUnknown) continue;
    switch (section.name) {
      case "vocab": {
        const entry = parseVocabLine(raw.text, raw.line, "document", diagnostics);
        if (entry) {
          vocab.add(entry, diagnostics);
          section.entries.push(entry);
        }
        break;
      }
      case "labels":
        parseLabelsLine(raw, section, symbols, vocab, diagnostics);
        break;
      case "gm":
        parseGmLine(raw, section, symbols, vocab, diagnostics);
        break;
      case "hexes": {
        const tokens = tokenize(raw.text, raw.line, diagnostics);
        if (tokens.some((t) => t.kind === "colon")) {
          lastEntity = parseEntityLine(raw, tokens, section, symbols, vocab, diagnostics, false);
        } else {
          parseHexLedgerLine(raw, tokens, section, symbols, diagnostics);
        }
        break;
      }
      default: {
        if (raw.indent > 0) {
          parseDetailLine(raw, lastEntity, vocab, diagnostics);
          break;
        }
        const tokens = tokenize(raw.text, raw.line, diagnostics);
        lastEntity = parseEntityLine(raw, tokens, section, symbols, vocab, diagnostics, false);
        break;
      }
    }
  }
  finishSection();
  reportUnknownHeaderKeys();
  reportDeadVocab(document, diagnostics);
  return { document, diagnostics };
  function parseEntityLine(raw, tokens, into, table, vocabTable, diags, gmOnly) {
    const split = splitAtColon(tokens, raw.line, diags);
    if (!split) return null;
    const subject = parseSubject(split.subject, raw.line, diags);
    const predicate = parsePredicate(split.predicate, raw.line, diags);
    for (const ref of predicate.refs) table.resolve(ref, raw.line, diags);
    let archetype;
    let archetypeSource;
    const known = subject.typeWord ? vocabTable.archetypeOf(subject.typeWord) : null;
    if (known) {
      archetype = known;
      archetypeSource = "vocab";
    } else {
      const inferred = inferArchetype(predicate.placements, into.name);
      archetype = inferred.archetype;
      archetypeSource = inferred.source;
    }
    if (archetype === "token" && predicate.placements.some((p) => p.kind === "range")) {
      diags.push(
        error(
          raw.line,
          "a token takes a cell (use size= for a larger token); for a staging area use 'start' ('start party : <range>'), and for another kind of zone declare the word ('[vocab] watch : zone') (spec 06 \xA74)"
        )
      );
    }
    const levelParam = predicate.pairs.find((p) => p.key === "level")?.value;
    const toParam = predicate.pairs.find((p) => p.key === "to")?.value;
    if (levelParam !== void 0 && !validLevel(levelParam)) {
      diags.push(error(raw.line, document.levels.length === 0 ? "level= requires a levels: declaration (spec 06 \xA78)" : `unknown level '${levelParam}' \u2014 declared levels: ${document.levels.join(" ")}`));
    }
    const throughParam = predicate.pairs.find((p) => p.key === "through")?.value;
    const checkLevelSpan = (key, value) => {
      const parts = value.split("..");
      if (parts.length > 2) {
        diags.push(error(raw.line, `${key}= takes a level or a range of two \u2014 '${value}' (spec 06 \xA78)`));
        return;
      }
      for (const part of parts) {
        if (validLevel(part)) continue;
        diags.push(error(raw.line, document.levels.length === 0 ? `${key}= requires a levels: declaration (spec 06 \xA78)` : `unknown level '${part}' \u2014 declared levels: ${document.levels.join(" ")}`));
      }
    };
    const detailAt = predicate.pairs.find((p) => p.key === "detail-at")?.value;
    if (detailAt !== void 0) {
      if (predicate.pairs.find((p) => p.key === "detail") === void 0) {
        diags.push(error(raw.line, "'detail-at=' anchors a 'detail=' sub-map and needs one to anchor (spec 03 \xA74)"));
      }
      if (parseAddress(detailAt) === null) {
        diags.push(error(raw.line, `'detail-at=${detailAt}' names the parent cell the sub-map's A1 sits on, e.g. 'detail-at=CP12' (spec 03 \xA74)`));
      }
    }
    if (toParam !== void 0) checkLevelSpan("to", toParam);
    if (throughParam !== void 0) {
      checkLevelSpan("through", throughParam);
      if (toParam === void 0) {
        diags.push(error(raw.line, "'through=' names the levels a connector passes WITHOUT opening onto, so it needs a 'to=' saying where it does open (spec 06 \xA78)"));
      }
    }
    checkDeclaredStates(subject.typeWord, predicate.flags, vocabTable, raw.line, diags);
    checkFacetValues(predicate.pairs, raw.line, diags);
    checkPairKeys(subject.typeWord, predicate.pairs, vocabTable, raw.line, diags);
    const entity = {
      kind: "entity",
      section: into.name,
      typeWord: subject.typeWord,
      ids: subject.ids,
      name: subject.name,
      archetype,
      archetypeSource,
      placements: predicate.placements,
      flags: predicate.flags,
      pairs: predicate.pairs,
      texts: predicate.texts,
      details: [],
      gmOnly: gmOnly || predicate.flags.includes("hidden"),
      level: levelParam ?? into.level ?? document.defaultLevel,
      line: raw.line
    };
    table.add(subject.ids, subject.name, raw.line, diags);
    into.entries.push(entity);
    return entity;
  }
  function parseDetailLine(raw, parent, vocabTable, diags) {
    if (!parent) {
      diagnostics.push(error(raw.line, "detail line has no parent entity"));
      return;
    }
    if (parent.archetype !== "structure") {
      diags.push(error(raw.line, "detail lines are only defined beneath structure entities (spec 06 \xA73)"));
      return;
    }
    const tokens = tokenize(raw.text, raw.line, diags);
    const split = splitAtColon(tokens, raw.line, diags);
    if (!split) return;
    const subject = parseSubject(split.subject, raw.line, diags);
    const predicate = parsePredicate(split.predicate, raw.line, diags);
    if (subject.typeWord !== null && vocabTable.archetypeOf(subject.typeWord) === "barrier") {
      const sides = predicate.flags.filter((f) => !isCompass(f));
      const hasEdges = predicate.placements.some((p) => p.kind === "edge" || p.kind === "relational" && p.form === "at" && p.target.kind === "edge");
      if (sides.length > 0) {
        diags.push(
          error(
            raw.line,
            `'${subject.typeWord}' replaces a side of this structure, so its predicate is side words or edge tokens \u2014 '${sides[0]}' is neither (spec 06 \xA73)`
          )
        );
      } else if (predicate.flags.length === 0 && !hasEdges) {
        diags.push(
          error(
            raw.line,
            `'${subject.typeWord}' replaces a side of this structure \u2014 name which: a side word ('${subject.typeWord} : east') or edge tokens ('${subject.typeWord} : K4.e K5.e') (spec 06 \xA73)`
          )
        );
      }
    } else {
      checkDeclaredStates(subject.typeWord, predicate.flags, vocabTable, raw.line, diags);
    }
    checkFacetValues(predicate.pairs, raw.line, diags);
    checkPairKeys(subject.typeWord, predicate.pairs, vocabTable, raw.line, diags);
    const detail = {
      kind: "detail",
      typeWord: subject.typeWord,
      ids: subject.ids,
      name: subject.name,
      placements: predicate.placements,
      flags: predicate.flags,
      pairs: predicate.pairs,
      texts: predicate.texts,
      line: raw.line
    };
    if (subject.ids.length > 0) symbols.add(subject.ids, subject.name, raw.line, diags);
    parent.details.push(detail);
  }
  function parseHexLedgerLine(raw, tokens, into, table, diags) {
    const addresses = [];
    let terrain = null;
    const contents = [];
    const flags = [];
    const pairs = [];
    let name = null;
    for (const t of tokens) {
      if (t.kind === "pair") {
        pairs.push({ key: t.key, value: t.value });
        continue;
      }
      if (t.kind === "string") {
        if (name !== null) diags.push(error(raw.line, "a hex line may carry only one display name"));
        else name = t.value;
        continue;
      }
      if (t.kind === "colon") continue;
      const positional = parsePositional(t.text);
      if (positional && (positional.kind === "address" || positional.kind === "range")) {
        if (terrain !== null) {
          diags.push(error(raw.line, "hex addresses must precede the terrain word"));
          continue;
        }
        addresses.push(positional);
        continue;
      }
      if (RESERVED_FLAGS.has(t.text)) {
        flags.push(t.text);
        continue;
      }
      if (terrain === null) terrain = t.text;
      else contents.push(t.text);
    }
    if (addresses.length === 0 || terrain === null) {
      diags.push(error(raw.line, `malformed hex ledger line \u2014 expected '<address> <terrain> [contents] ["Name"]' (spec 05 \xA73)`));
      return;
    }
    const node = { kind: "hex-line", addresses, terrain, contents, name, flags, pairs, line: raw.line };
    table.add([], name, raw.line, diags);
    into.entries.push(node);
  }
  function parseGmLine(raw, into, table, vocabTable, diags) {
    const tokens = tokenize(raw.text, raw.line, diags);
    const split = splitAtColon(tokens, raw.line, diags);
    if (!split) return;
    if (split.subject.length === 1) {
      const t = split.subject[0];
      const ref = t.kind === "chunk" ? { kind: "ref", form: "id", value: t.text } : t.kind === "string" ? { kind: "ref", form: "name", value: t.value } : null;
      if (ref && table.tryResolve(ref)) {
        const predicate = parsePredicate(split.predicate, raw.line, diags);
        if (predicate.placements.length > 0) {
          diags.push(error(raw.line, "a [gm] attachment must not contain a placement \u2014 repositioning from [gm] is an error (spec 03 \xA75)"));
        }
        for (const r of predicate.refs) table.resolve(r, raw.line, diags);
        const node = {
          kind: "gm-attachment",
          target: ref,
          texts: predicate.texts,
          pairs: predicate.pairs,
          flags: predicate.flags,
          line: raw.line
        };
        into.entries.push(node);
        return;
      }
    }
    const entity = parseEntityLine(raw, tokens, into, table, vocabTable, diags, true);
    if (entity && entity.placements.length === 0) {
      diags.push(
        error(raw.line, `[gm] line resolves no existing entity and declares no placement \u2014 a misspelled attachment target? (spec 03 \xA75)`)
      );
    }
  }
  function parseLabelsLine(raw, into, table, vocabTable, diags) {
    const tokens = tokenize(raw.text, raw.line, diags);
    const split = splitAtColon(tokens, raw.line, diags);
    if (!split) return;
    const first = split.subject[0];
    if (first?.kind === "chunk" && vocabTable.chain(first.text).includes("note")) {
      parseEntityLine(raw, tokens, into, table, vocabTable, diags, false);
      return;
    }
    if (split.subject.length !== 1) {
      diags.push(error(raw.line, "a [labels] override subject must be a single reference; free text requires the 'note' type word or a word deriving from it (spec 07 \xA72)"));
      return;
    }
    const t = split.subject[0];
    const ref = t.kind === "chunk" ? { kind: "ref", form: "id", value: t.text } : t.kind === "string" ? { kind: "ref", form: "name", value: t.value } : null;
    if (!ref) {
      diags.push(error(raw.line, "malformed [labels] subject"));
      return;
    }
    table.resolve(ref, raw.line, diags);
    const hint = parseLabelHint(split.predicate, raw.line, table, diags);
    if (!hint) return;
    const node = { kind: "label-override", target: ref, hint, line: raw.line };
    into.entries.push(node);
  }
  function parseLabelHint(tokens, line, table, diags) {
    const first = tokens[0];
    if (first?.kind !== "chunk") {
      diags.push(error(line, "expected a label hint: sprawl | along | at | <compass> (spec 07 \xA72)"));
      return null;
    }
    if (first.text === "sprawl") {
      const arg = tokens[1]?.kind === "chunk" ? parsePositional(tokens[1].text) : null;
      if (arg?.kind === "range" || arg?.kind === "point-range") return { kind: "sprawl", range: arg };
      diags.push(error(line, "sprawl requires a cell range or point range"));
      return null;
    }
    if (first.text === "along") {
      const t = tokens[1];
      const ref = t?.kind === "chunk" ? { kind: "ref", form: "id", value: t.text } : t?.kind === "string" ? { kind: "ref", form: "name", value: t.value } : null;
      if (!ref) {
        diags.push(error(line, "along requires a reference"));
        return null;
      }
      table.resolve(ref, line, diags);
      return { kind: "along", ref };
    }
    if (first.text === "at") {
      const arg = tokens[1]?.kind === "chunk" ? parsePositional(tokens[1].text) : null;
      if (arg?.kind === "point" || arg?.kind === "address") return { kind: "at", target: arg };
      diags.push(error(line, "at requires a point or cell"));
      return null;
    }
    if (isCompass(first.text)) return { kind: "side", compass: first.text };
    diags.push(error(line, `unknown label hint '${first.text}' \u2014 expected sprawl | along | at | <compass>`));
    return null;
  }
}

// packages/core/src/theme.ts
var THEME_PROPS = /* @__PURE__ */ new Set(["fill", "stroke", "width", "dash", "opacity", "glyph", "asset", "edge", "bank"]);
var BANK_VALUES = /* @__PURE__ */ new Set(["land", "water", "both"]);
var SURFACE_WORDS = /* @__PURE__ */ new Set(["paper", "grid", "fog", "ink", "light", "ledge", "leader"]);
function parseThemeDocument(source, diagnostics) {
  const doc = { entries: [], glyphs: {}, glyphLines: {}, uses: [] };
  let section = null;
  let first = true;
  for (const raw of splitLines(source)) {
    if (first && raw.text.startsWith("#")) {
      first = false;
      continue;
    }
    first = false;
    const sectionMatch = /^\[(.+)\]$/.exec(raw.text);
    if (sectionMatch) {
      const name = sectionMatch[1];
      section = name === "theme" ? "theme" : name === "glyphs" ? "glyphs" : "other";
      if (section === "other") diagnostics.push(warning(raw.line, `theme document: ignoring section [${name}]`));
      continue;
    }
    const tokens = tokenize(raw.text, raw.line, diagnostics);
    const colonIndex = tokens.findIndex((t) => t.kind === "colon");
    if (section === null) {
      const key = tokens[0];
      if (colonIndex === 1 && key?.kind === "chunk" && key.text === "kind") {
        continue;
      }
      if (colonIndex === 1 && key?.kind === "chunk" && key.text === "use") {
        const value = tokens.slice(2).map((t) => t.kind === "chunk" ? t.text : "").join(" ").trim();
        if (value) doc.uses.push(value);
      } else {
        diagnostics.push(warning(raw.line, "theme document: ignoring header line (only 'use:' applies)"));
      }
      continue;
    }
    if (section === "other") continue;
    if (colonIndex === -1) {
      diagnostics.push(error(raw.line, "expected 'subject : properties'"));
      continue;
    }
    if (section === "glyphs") {
      const name = tokens[0];
      const path = tokens[colonIndex + 1];
      if (name?.kind !== "chunk" || path?.kind !== "string") {
        diagnostics.push(error(raw.line, `malformed [glyphs] line \u2014 expected 'name : "SVG path data"'`));
        continue;
      }
      doc.glyphs[name.text] = path.value;
      doc.glyphLines[name.text] = raw.line;
      continue;
    }
    const subjectToken = tokens[0];
    if (colonIndex !== 1 || subjectToken?.kind !== "chunk") {
      diagnostics.push(error(raw.line, "malformed [theme] line \u2014 expected a single subject before ':'"));
      continue;
    }
    const dot = subjectToken.text.indexOf(".");
    const base = dot === -1 ? subjectToken.text : subjectToken.text.slice(0, dot);
    const sub = dot === -1 ? null : subjectToken.text.slice(dot + 1);
    const pairs = {};
    for (const t of tokens.slice(colonIndex + 1)) {
      if (t.kind === "pair") {
        if (!THEME_PROPS.has(t.key)) {
          diagnostics.push(warning(raw.line, `unknown theme property '${t.key}' \u2014 the appearance vocabulary is closed (spec 08 \xA73)`));
          continue;
        }
        if (t.key === "bank" && !BANK_VALUES.has(t.value)) {
          diagnostics.push(warning(raw.line, `'bank=${t.value}' is not one of ${[...BANK_VALUES].join(", ")} \u2014 a border lies on the land, on the water, or on both, and never centred on the line (spec 08 \xA73)`));
          continue;
        }
        pairs[t.key] = t.value;
      } else {
        diagnostics.push(warning(raw.line, "theme lines take only key=value properties"));
      }
    }
    doc.entries.push({ base, sub, pairs, line: raw.line });
  }
  return doc;
}

// packages/core/src/spline.ts
function catmullRom(pts, samples = 8, closed = false) {
  if (pts.length < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  const P = (i) => closed ? pts[(i % pts.length + pts.length) % pts.length] : pts[Math.max(0, Math.min(pts.length - 1, i))];
  const knot = (a, b) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
  const out = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const d1 = knot(p1, p2) || 1;
    const d0 = knot(p0, p1) || d1;
    const d2 = knot(p2, p3) || d1;
    const t0 = 0;
    const t1 = d0;
    const t2 = t1 + d1;
    const t3 = t2 + d2;
    for (let s = 0; s < samples; s++) {
      const t = t1 + d1 * s / samples;
      const a1x = ((t1 - t) * p0.x + (t - t0) * p1.x) / (t1 - t0);
      const a1y = ((t1 - t) * p0.y + (t - t0) * p1.y) / (t1 - t0);
      const a2x = ((t2 - t) * p1.x + (t - t1) * p2.x) / (t2 - t1);
      const a2y = ((t2 - t) * p1.y + (t - t1) * p2.y) / (t2 - t1);
      const a3x = ((t3 - t) * p2.x + (t - t2) * p3.x) / (t3 - t2);
      const a3y = ((t3 - t) * p2.y + (t - t2) * p3.y) / (t3 - t2);
      const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
      const b1y = ((t2 - t) * a1y + (t - t0) * a2y) / (t2 - t0);
      const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
      const b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);
      out.push({
        x: ((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1),
        y: ((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1)
      });
    }
  }
  if (!closed) {
    const last = pts[pts.length - 1];
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

// packages/render-svg/src/util.ts
var QUANTUM = 0.01;
var fmt = (n) => {
  const rounded = Math.round(n / QUANTUM) * QUANTUM;
  return Object.is(rounded, -0) ? "0" : String(Number(rounded.toFixed(2)));
};
var esc = (text2) => text2.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function el(name, attrs, ...children) {
  const attrText = Object.entries(attrs).filter(([, v]) => v !== void 0).map(([k, v]) => ` ${k}="${typeof v === "number" ? fmt(v) : esc(String(v))}"`).join("");
  const body = children.join("");
  return body ? `<${name}${attrText}>${body}</${name}>` : `<${name}${attrText}/>`;
}
var svgTitle = (content) => `<title>${esc(content)}</title>`;
var text = (content, attrs) => `<text${Object.entries(attrs).filter(([, v]) => v !== void 0).map(([k, v]) => ` ${k}="${typeof v === "number" ? fmt(v) : esc(String(v))}"`).join("")}>${esc(content)}</text>`;
var pointsAttr = (pts) => {
  const out = [];
  for (const p of pts) {
    const at = `${fmt(p.x)},${fmt(p.y)}`;
    if (at !== out[out.length - 1]) out.push(at);
  }
  return out.join(" ");
};
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function hashSeed(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    const v = Math.round(n * 8) | 0;
    h = Math.imul(h ^ v & 255, 16777619);
    h = Math.imul(h ^ v >> 8 & 255, 16777619);
    h = Math.imul(h ^ v >> 16 & 255, 16777619);
  }
  return h >>> 0;
}
var INSET = 0.38;
function organicMass(center, size, shortRatio, angle, random, segments = 14) {
  const raw = [];
  for (let i = 0; i < segments; i++) {
    const a = i / segments * Math.PI * 2;
    const r = 1 - INSET * random();
    raw.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  const smooth = catmullRom(raw, 5, true);
  const xs = smooth.map((p) => p.x);
  const ys = smooth.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const kx = x1 > x0 ? size / (x1 - x0) : 1;
  const ky = y1 > y0 ? size * shortRatio / (y1 - y0) : 1;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return smooth.map((p) => {
    const x = (p.x - cx) * kx;
    const y = (p.y - cy) * ky;
    return { x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos };
  });
}
function pip(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function nearestOnPolyline(pts, target) {
  let best = pts[0];
  let bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / lenSq));
    const p = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - target.x, p.y - target.y);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}
function subPolylineBetween(pts, a, b) {
  const param = (target) => {
    let best = { d: Infinity, i: 0, t: 0, p: pts[0] };
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const lenSq = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((target.x - p1.x) * dx + (target.y - p1.y) * dy) / lenSq));
      const p = { x: p1.x + t * dx, y: p1.y + t * dy };
      const d = Math.hypot(p.x - target.x, p.y - target.y);
      if (d < best.d) best = { d, i, t, p };
    }
    return best;
  };
  let pa = param(a);
  let pb = param(b);
  let reversed = false;
  if (pa.i > pb.i || pa.i === pb.i && pa.t > pb.t) {
    [pa, pb] = [pb, pa];
    reversed = true;
  }
  const out = [pa.p];
  for (let i = pa.i + 1; i <= pb.i; i++) out.push(pts[i]);
  out.push(pb.p);
  if (reversed) out.reverse();
  return out;
}
var COMPASS_VECTORS = {
  n: { x: 0, y: -1 },
  north: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  south: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  east: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
  west: { x: -1, y: 0 },
  ne: { x: 0.707, y: -0.707 },
  northeast: { x: 0.707, y: -0.707 },
  nw: { x: -0.707, y: -0.707 },
  northwest: { x: -0.707, y: -0.707 },
  se: { x: 0.707, y: 0.707 },
  southeast: { x: 0.707, y: 0.707 },
  sw: { x: -0.707, y: 0.707 },
  southwest: { x: -0.707, y: 0.707 }
};
function colToNumber2(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function colLetters(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function measureToNumber(measure) {
  const m = /^(\d+(?:\.\d+)?)/.exec(measure);
  return m ? Number(m[1]) : 0;
}
function raySegment(o, d, seg) {
  const sx = seg.b.x - seg.a.x;
  const sy = seg.b.y - seg.a.y;
  const denom = d.x * sy - d.y * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const ox = seg.a.x - o.x;
  const oy = seg.a.y - o.y;
  const t = (ox * sy - oy * sx) / denom;
  const s = (ox * d.y - oy * d.x) / denom;
  if (t >= 0 && s >= -1e-9 && s <= 1 + 1e-9) return t;
  return null;
}
function visibilityPolygon(center, radius, blockers, steps = 180) {
  const pts = [];
  for (let k = 0; k < steps; k++) {
    const angle = 2 * Math.PI * k / steps;
    const d = { x: Math.cos(angle), y: Math.sin(angle) };
    let reach = radius;
    for (const seg of blockers) {
      const t = raySegment(center, d, seg);
      if (t !== null && t < reach) reach = t;
    }
    pts.push({ x: center.x + d.x * reach, y: center.y + d.y * reach });
  }
  return pts;
}

// packages/render-svg/src/grid.ts
var CELL = 32;
var MARGIN = 24;
var cellOrigin = (a) => ({
  x: MARGIN + (colToNumber2(a.col) - 1) * CELL,
  y: MARGIN + (a.row - 1) * CELL
});
var cellCenter = (a) => {
  const o = cellOrigin(a);
  return { x: o.x + CELL / 2, y: o.y + CELL / 2 };
};
var rangeRect = (r) => {
  const a = cellOrigin(r.from);
  const b = cellOrigin(r.to);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x) + CELL, h: Math.abs(b.y - a.y) + CELL };
};
function measureToCells(measure, model) {
  const scale = measureToNumber(model.header.get("scale") ?? "5") || 5;
  return measureToNumber(measure) / scale;
}
var segKey = (s) => {
  const pts = [s.a, s.b].sort((p, q) => p.x - q.x || p.y - q.y);
  return `${Math.round(pts[0].x)},${Math.round(pts[0].y)}|${Math.round(pts[1].x)},${Math.round(pts[1].y)}`;
};
function edgeSegment(at, dir) {
  const o = cellOrigin(at);
  switch (dir) {
    case "n":
      return { a: { x: o.x, y: o.y }, b: { x: o.x + CELL, y: o.y } };
    case "s":
      return { a: { x: o.x, y: o.y + CELL }, b: { x: o.x + CELL, y: o.y + CELL } };
    case "w":
      return { a: { x: o.x, y: o.y }, b: { x: o.x, y: o.y + CELL } };
    default:
      return { a: { x: o.x + CELL, y: o.y }, b: { x: o.x + CELL, y: o.y + CELL } };
  }
}
function titleBand(doc, header) {
  return doc.title && header.get("numbers") === "on" ? 20 : 0;
}
var cellKey = (c) => `${c.col}:${c.row}`;
function structureCells(e) {
  const cells = /* @__PURE__ */ new Map();
  const add = (c) => void cells.set(cellKey(c), c);
  for (const p of e.placements) {
    if (p.kind === "address") {
      add({ col: colToNumber2(p.col), row: p.row });
    } else if (p.kind === "range") {
      const c1 = Math.min(colToNumber2(p.from.col), colToNumber2(p.to.col));
      const c2 = Math.max(colToNumber2(p.from.col), colToNumber2(p.to.col));
      const r1 = Math.min(p.from.row, p.to.row);
      const r2 = Math.max(p.from.row, p.to.row);
      for (let col = c1; col <= c2; col++) for (let row = r1; row <= r2; row++) add({ col, row });
    }
  }
  return cells;
}
function surfaceCells(e) {
  const width = Number(e.pairs.find((p) => p.key === "width")?.value ?? 1) || 1;
  const cells = /* @__PURE__ */ new Map();
  for (const p of e.placements) {
    if (p.kind === "shape" && p.shape === "path") {
      const vertices = p.args.filter((a) => a.kind === "address").map((a) => ({ col: colToNumber2(a.col), row: a.row }));
      for (const [key, cell] of pathBandCells(vertices, width)) cells.set(key, cell);
      continue;
    }
    const flat = p.kind === "shape" ? p.args : [p];
    for (const [key, cell] of structureCells({ placements: flat })) cells.set(key, cell);
  }
  return cells;
}
function pathBandCells(vertices, widthCells) {
  const cells = /* @__PURE__ */ new Map();
  if (vertices.length === 0) return cells;
  const half = Math.max(widthCells, 1) / 2;
  const pad = Math.ceil(half) + 1;
  const cols = vertices.map((v) => v.col);
  const rows = vertices.map((v) => v.row);
  const c0 = Math.max(1, Math.min(...cols) - pad);
  const c1 = Math.max(...cols) + pad;
  const r0 = Math.max(1, Math.min(...rows) - pad);
  const r1 = Math.max(...rows) + pad;
  for (let col = c0; col <= c1; col++) {
    for (let row = r0; row <= r1; row++) {
      const p = { x: col - 0.5, y: row - 0.5 };
      let best = Infinity;
      for (let i = 0; i + 1 < vertices.length; i++) {
        best = Math.min(best, distToSegment(p, vertices[i], vertices[i + 1]));
      }
      if (vertices.length === 1) best = Math.hypot(p.x - (vertices[0].col - 0.5), p.y - (vertices[0].row - 0.5));
      if (best <= half) cells.set(cellKey({ col, row }), { col, row });
    }
  }
  return cells;
}
function distToSegment(p, a, b) {
  const ax = a.col - 0.5, ay = a.row - 0.5, bx = b.col - 0.5, by = b.row - 0.5;
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / lengthSquared));
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
}
var NEIGHBOR = {
  n: { dc: 0, dr: -1 },
  s: { dc: 0, dr: 1 },
  w: { dc: -1, dr: 0 },
  e: { dc: 1, dr: 0 }
};
function perimeterEdges(cells) {
  const edges = [];
  const ordered = [...cells.values()].sort((a, b) => a.row - b.row || a.col - b.col);
  for (const cell of ordered) {
    for (const dir of ["n", "e", "s", "w"]) {
      const n = NEIGHBOR[dir];
      if (!cells.has(cellKey({ col: cell.col + n.dc, row: cell.row + n.dr }))) edges.push({ cell, dir });
    }
  }
  return edges;
}
function mergeEdgeRuns(edges) {
  const runs = [];
  const horizontal = (dir) => {
    const rows = /* @__PURE__ */ new Map();
    for (const e of edges) {
      if (e.dir !== dir) continue;
      const key = String(e.cell.row);
      const list = rows.get(key) ?? [];
      list.push(e.cell.col);
      rows.set(key, list);
    }
    for (const [rowKey, cols] of [...rows.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const row = Number(rowKey);
      cols.sort((a, b) => a - b);
      let start = cols[0];
      let prev = cols[0];
      const y = MARGIN + (row - 1) * CELL + (dir === "s" ? CELL : 0);
      const flush = (endCol) => void runs.push({ dir, x1: MARGIN + (start - 1) * CELL, y1: y, x2: MARGIN + endCol * CELL, y2: y });
      for (const col of cols.slice(1)) {
        if (col !== prev + 1) {
          flush(prev);
          start = col;
        }
        prev = col;
      }
      flush(prev);
    }
  };
  const vertical = (dir) => {
    const cols = /* @__PURE__ */ new Map();
    for (const e of edges) {
      if (e.dir !== dir) continue;
      const key = String(e.cell.col);
      const list = cols.get(key) ?? [];
      list.push(e.cell.row);
      cols.set(key, list);
    }
    for (const [colKey, rowList] of [...cols.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const col = Number(colKey);
      rowList.sort((a, b) => a - b);
      let start = rowList[0];
      let prev = rowList[0];
      const x = MARGIN + (col - 1) * CELL + (dir === "e" ? CELL : 0);
      const flush = (endRow) => void runs.push({ dir, x1: x, y1: MARGIN + (start - 1) * CELL, x2: x, y2: MARGIN + endRow * CELL });
      for (const row of rowList.slice(1)) {
        if (row !== prev + 1) {
          flush(prev);
          start = row;
        }
        prev = row;
      }
      flush(prev);
    }
  };
  horizontal("n");
  horizontal("s");
  vertical("w");
  vertical("e");
  return runs;
}

// packages/render-svg/src/model.ts
var pairOf = (pairs, key) => pairs.find((p) => p.key === key)?.value;
function entityAnchor(e) {
  if (e.ids.length > 0) return e.ids[0];
  if (e.name) return slugify(e.name);
  return null;
}
function buildModel(doc, mode, theme, diagnostics = []) {
  const entities = [];
  const hexLines = [];
  const labelOverrides = [];
  const gmNotes = /* @__PURE__ */ new Map();
  const refKey = (ref) => ref.form === "id" ? ref.value : slugify(ref.value);
  for (const section of doc.sections) {
    for (const entry of section.entries) {
      switch (entry.kind) {
        case "entity": {
          if (mode === "player" && (entry.gmOnly || entry.flags.includes("hidden"))) break;
          entities.push(entry);
          break;
        }
        case "hex-line":
          hexLines.push(entry);
          break;
        case "label-override":
          labelOverrides.push(entry);
          break;
        case "gm-attachment": {
          if (mode === "gm") {
            const attachment = entry;
            const key = refKey(attachment.target);
            const notes = gmNotes.get(key) ?? [];
            notes.push(...attachment.texts, ...attachment.pairs.filter((p) => p.key === "gm").map((p) => p.value));
            gmNotes.set(key, notes);
          }
          break;
        }
        case "vocab-entry":
          break;
      }
    }
  }
  const header = new Map(doc.header.map((h) => [h.key, h.value]));
  const seed = Number(header.get("seed") ?? 0) || 0;
  const vocab = new VocabTable();
  loadStdlib(vocab);
  const scratch = [];
  for (const entry of doc.importedVocab) vocab.add(entry, scratch);
  for (const section of doc.sections) {
    for (const entry of section.entries) {
      if (entry.kind === "vocab-entry") vocab.add(entry, scratch);
    }
  }
  const chainOf = (word) => word ? vocab.chain(word) : [];
  const archetypeOf = (word) => word ? vocab.archetypeOf(word) : null;
  const facetOf = (word, key) => word ? vocab.facetOf(word, key) : void 0;
  const labelsHeader = header.get("labels");
  const labelsMode = labelsHeader === "none" ? "none" : labelsHeader === "keyed" ? "keyed" : "names";
  const resolvedNotes = /* @__PURE__ */ new Map();
  expandEveryAlong(entities, doc, diagnostics);
  if (doc.mapType === "battlemap") {
    resolveRelativePlacements(entities, chainOf, resolvedNotes, diagnostics);
  }
  const keys = labelsMode === "none" ? /* @__PURE__ */ new Map() : assignKeys(entities, hexLines, diagnostics, labelsMode === "keyed");
  return { doc, mode, entities, hexLines, labelOverrides, gmNotes, header, seed, theme, labelsMode, keys, chainOf, archetypeOf, facetOf, resolvedNotes };
}
function assignKeys(entities, hexLines, diagnostics, numberEverything) {
  const keys = /* @__PURE__ */ new Map();
  const named = [];
  const collect = (node) => {
    if (!node.name || node.flags.includes("nolabel")) return;
    const raw = pairOf(node.pairs, "key");
    const pin = raw !== void 0 ? Number(raw) : null;
    if (raw !== void 0 && (!Number.isInteger(pin) || pin < 1)) {
      diagnostics.push({ severity: "error", line: node.line, message: `key=${raw} is not a positive integer (spec 07 \xA73)` });
      return;
    }
    named.push({ node, pin, line: node.line });
  };
  for (const e of entities) collect(e);
  for (const hex of hexLines) collect(hex);
  const used = /* @__PURE__ */ new Set();
  for (const n of named) {
    if (n.pin === null) continue;
    if (used.has(n.pin)) {
      diagnostics.push({ severity: "error", line: n.line, message: `key=${n.pin} is pinned twice (spec 07 \xA73)` });
      continue;
    }
    used.add(n.pin);
    keys.set(n.node, n.pin);
  }
  if (!numberEverything) return keys;
  let next = 1;
  for (const n of named) {
    if (keys.has(n.node)) continue;
    while (used.has(next)) next++;
    used.add(next);
    keys.set(n.node, next);
  }
  return keys;
}
var localText = (p) => p.kind === "address" ? `${p.col}${p.row}` : p.kind === "range" ? `${p.from.col}${p.from.row}..${p.to.col}${p.to.row}` : `${p.at.col}${p.at.row}.${p.dir}`;
function footprintCells(e) {
  const cells = /* @__PURE__ */ new Set();
  for (const p of e.placements) {
    if (p.kind === "address") cells.add(`${colToNumber2(p.col)}:${p.row}`);
    if (p.kind === "range") {
      const c1 = Math.min(colToNumber2(p.from.col), colToNumber2(p.to.col));
      const c2 = Math.max(colToNumber2(p.from.col), colToNumber2(p.to.col));
      const r1 = Math.min(p.from.row, p.to.row);
      const r2 = Math.max(p.from.row, p.to.row);
      for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) cells.add(`${c}:${r}`);
    }
  }
  return cells;
}
function resolveRelativePlacements(entities, chainOf, resolvedNotes, diagnostics) {
  const byId = /* @__PURE__ */ new Map();
  const byName = /* @__PURE__ */ new Map();
  for (const e of entities) {
    for (const id of e.ids) if (!byId.has(id)) byId.set(id, e);
    if (e.name && !byName.has(e.name)) byName.set(e.name, e);
  }
  const displayName = (e) => e.name ?? e.ids[0] ?? e.typeWord ?? "structure";
  const translateAgainst = (local, parent, line) => {
    const cells = footprintCells(parent);
    if (cells.size === 0) return null;
    let colMin = Infinity;
    let rowMin = Infinity;
    for (const key of cells) {
      const [c, r] = key.split(":").map(Number);
      if (c < colMin) colMin = c;
      if (r < rowMin) rowMin = r;
    }
    const shift = (a) => {
      const col = colMin + colToNumber2(a.col) - 1;
      const row = rowMin + a.row - 1;
      if (!cells.has(`${col}:${row}`)) {
        diagnostics.push({
          severity: "error",
          line,
          message: `local cell ${a.col}${a.row} lies outside '${displayName(parent)}' \u2014 its footprint is ${cells.size} cells with NW at ${colLetters(colMin)}${rowMin} (spec 02 \xA77)`
        });
        return null;
      }
      return { kind: "address", col: colLetters(col), row };
    };
    if (local.kind === "address") return shift(local);
    if (local.kind === "edge") {
      const at = shift(local.at);
      return at ? { kind: "edge", at, dir: local.dir } : null;
    }
    const from = shift(local.from);
    const to = shift(local.to);
    return from && to ? { kind: "range", from, to } : null;
  };
  entities.forEach((e, index) => {
    let changed = false;
    const notes = [];
    const placements = e.placements.map((p) => {
      if (p.kind !== "relational" || p.form !== "on" || p.at === void 0) return p;
      const parent = p.ref.form === "id" ? byId.get(p.ref.value) : byName.get(p.ref.value);
      if (!parent) return p;
      if (parent.archetype !== "structure") {
        const chain = chainOf(e.typeWord);
        if (chain.includes("ford") || chain.includes("bridge")) return p;
        diagnostics.push({
          severity: "error",
          line: e.line,
          message: `'on ${p.ref.value} at ${localText(p.at)}' needs a structure footprint to place against \u2014 '${p.ref.value}' is a ${parent.archetype} (spec 02 \xA77)`
        });
        return p;
      }
      if (parent.level !== e.level) {
        diagnostics.push({
          severity: "error",
          line: e.line,
          message: `'on ${p.ref.value} at ${localText(p.at)}' crosses levels \u2014 '${displayName(parent)}' is on level ${parent.level || "(default)"}, this entity on ${e.level || "(default)"} (spec 06 \xA78)`
        });
        return p;
      }
      const absolute = translateAgainst(p.at, parent, e.line);
      if (!absolute) return p;
      changed = true;
      notes.push(`${localText(p.at)} of ${displayName(parent)} = ${localText(absolute)}`);
      return absolute;
    });
    const details = e.details.map((d) => {
      const mapped = d.placements.map((p) => {
        if (p.kind !== "relational" || p.form !== "at" || p.target.kind === "point") return p;
        const absolute = translateAgainst(p.target, e, d.line);
        if (!absolute) return p;
        changed = true;
        return absolute;
      });
      return mapped.some((p, k) => p !== d.placements[k]) ? { ...d, placements: mapped } : d;
    });
    if (changed) {
      const clone = { ...e, placements, details };
      entities[index] = clone;
      if (notes.length > 0) resolvedNotes.set(clone, notes.join("; "));
      if (byName.get(e.name ?? "") === e && e.name) byName.set(e.name, clone);
      for (const id of e.ids) if (byId.get(id) === e) byId.set(id, clone);
    }
  });
}
function labelsOn(model, e) {
  return model.labelsMode !== "none" || e?.typeWord === "note";
}
function labelTextFor(model, node) {
  if (!node.name) return null;
  const key = model.keys.get(node);
  if (key !== void 0) return String(key);
  if (model.labelsMode === "keyed") return null;
  return node.name;
}
var anchorAttr = (model, e) => {
  const anchor = entityAnchor(e);
  return anchor ? `cd-${model.doc.docId}-${anchor}` : void 0;
};
function gmTitleFor(model, e) {
  if (model.mode !== "gm") return null;
  const parts = [];
  const own = pairOf(e.pairs, "gm");
  if (own) parts.push(own);
  if (e.gmOnly) parts.push(...e.texts);
  const anchor = entityAnchor(e);
  if (anchor) parts.push(...model.gmNotes.get(anchor) ?? []);
  return parts.length ? parts.join(" ") : null;
}
function expandEveryAlong(entities, doc, diagnostics) {
  const scale = measureToNumber(doc.header.find((h) => h.key === "scale")?.value ?? "5") || 5;
  const courseOf = (ref) => {
    for (const other of entities) {
      const matches = ref.form === "id" ? other.ids.includes(ref.value) : other.name === ref.value;
      if (!matches) continue;
      const cells = [];
      const points = [];
      for (const p of other.placements) {
        if (p.kind === "shape") {
          for (const arg of p.args) {
            if (arg.kind === "address") cells.push(arg);
            else if (arg.kind === "point") points.push(arg);
          }
        } else if (p.kind === "relational" && p.form === "from-to") {
          if (p.from.at.kind === "point") points.push(p.from.at);
          points.push(...p.via);
          if (p.to.at.kind === "point") points.push(p.to.at);
        }
      }
      return { cells, points };
    }
    return null;
  };
  for (const e of entities) {
    const spec = e.placements.find(
      (p) => p.kind === "relational" && p.form === "every-along"
    );
    if (!spec) continue;
    const course = courseOf(spec.ref);
    if (!course) {
      diagnostics.push({ severity: "error", line: e.line, message: `'every ${spec.measure} along ${spec.ref.value}' \u2014 no such feature to follow (spec 02 \xA79)` });
      continue;
    }
    const step = measureToNumber(spec.measure);
    if (!(step > 0)) {
      diagnostics.push({ severity: "error", line: e.line, message: `'every ${spec.measure} along ${spec.ref.value}' needs a positive spacing (spec 02 \xA79)` });
      continue;
    }
    const others = e.placements.filter((p) => p !== spec);
    if (course.cells.length > 1) {
      const chain = [];
      for (let i = 1; i < course.cells.length; i++) {
        const a = course.cells[i - 1];
        const b = course.cells[i];
        const ac = colToNumber2(a.col);
        const bc = colToNumber2(b.col);
        const steps = Math.max(Math.abs(bc - ac), Math.abs(b.row - a.row));
        for (let k = 0; k < steps; k++) {
          chain.push({
            kind: "address",
            col: colLetters(ac + Math.round((bc - ac) * k / steps)),
            row: a.row + Math.round((b.row - a.row) * k / steps)
          });
        }
      }
      chain.push(course.cells[course.cells.length - 1]);
      const stride = Math.max(1, Math.round(step / scale));
      const picked = [];
      for (let i = 0; i < chain.length; i += stride) picked.push(chain[i]);
      e.placements = [...others, ...picked];
    } else if (course.points.length > 1) {
      const picked = [];
      let carry = 0;
      picked.push(course.points[0]);
      for (let i = 1; i < course.points.length; i++) {
        const a = course.points[i - 1];
        const b = course.points[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        let travelled = step - carry;
        while (travelled <= len) {
          const t = travelled / len;
          picked.push({ kind: "point", x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
          travelled += step;
        }
        carry = (carry + len) % step;
      }
      e.placements = [...others, ...picked];
    } else {
      diagnostics.push({ severity: "error", line: e.line, message: `'${spec.ref.value}' has no course to space along \u2014 it needs at least two points (spec 02 \xA79)` });
    }
  }
}

// packages/render-svg/src/theme.ts
var PAPER = "#f9f5ea";
var GRID_LINE = "#c9c2b0";
var FOG = "#ded8ca";
var INK = "#3d3629";
var TERRAIN_FILLS = {
  sea: "#b9d3e6",
  lake: "#b9d3e6",
  water: "#b9d3e6",
  plains: "#e9e3c6",
  grassland: "#dde5b8",
  farmland: "#e7d9a6",
  forest: "#a9c79c",
  jungle: "#8fbc8b",
  hills: "#d9cba6",
  mountains: "#c3b8a5",
  peak: "#c3b8a5",
  volcano: "#b0a094",
  marsh: "#c2d2c0",
  desert: "#eeddb0",
  dunes: "#eeddb0",
  snowfield: "#eff2f4",
  snow: "#eff2f4",
  tundra: "#dfe4dd",
  ice: "#dcebf2",
  wasteland: "#d4c8b8",
  mud: "#c8b294",
  sand: "#ecdfb8",
  grass: "#dde5b8",
  island: "#e9e2cc",
  rubble: "#cfc8bc",
  slope: "#d9d0bd",
  ford: "#cfd4b8",
  earth: "#6b6157",
  roof: "#bf9c85",
  air: "#e9edee",
  terrace: "#e3ddcc"
};
var PATH_STROKES = {
  river: { stroke: "#7fa8cf" },
  stream: { stroke: "#7fa8cf" },
  canal: { stroke: "#7fa8cf" },
  road: { stroke: "#c3a878" },
  trail: { stroke: "#c3a878", dash: "6 4" },
  pass: { stroke: "#a89880", dash: "4 4" },
  coastline: { stroke: "#8fa8b8" },
  border: { stroke: "#a05a5a", dash: "8 4" }
};
var TIERS = {
  // Fonts sit well below the 18px map title — a capital is the biggest
  // SETTLEMENT, not a rival heading (owner round eleven).
  capital: { r: 6, font: 13, weight: "bold" },
  city: { r: 5, font: 11, weight: "bold" },
  town: { r: 4, font: 10, weight: "normal" },
  village: { r: 3, font: 9, weight: "normal" },
  hamlet: { r: 2.5, font: 8, weight: "normal" },
  settlement: { r: 3.5, font: 9, weight: "normal" }
};
var SIDE_COLORS = {
  party: "#4a7ab5",
  ally: "#4a9a6a",
  foe: "#b5504a"
};
var BATTLEMAP_GLYPHS = /* @__PURE__ */ new Set(["campfire", "torch", "lantern", "brazier", "wagon"]);
var DEFAULT_THEME_SOURCE = [
  "# Chartdown Default Theme",
  "",
  "[theme]",
  `paper : fill=${PAPER}`,
  `grid : stroke=${GRID_LINE}`,
  `fog : fill=${FOG}`,
  `ink : fill=${INK}`,
  "light : fill=#ffd98a",
  // Ambient conditions for the shipped field (#106): a value with no entry
  // draws no wash at all, so a renderer never invents a tone it was not told.
  "light.dark : fill=#10131a opacity=0.86",
  "light.dim : fill=#1b2029 opacity=0.55",
  "light.moonlight : fill=#1d2740 opacity=0.45",
  "ledge : stroke=#6b5d4a",
  "building : fill=#efe9da",
  "building.open : fill=#e3ddc2 ; unroofed interiors read as outdoor ground (spec 06 par.3)",
  // Openings and barriers are ordinary theme subjects (#105) — they were
  // hardcoded at the draw site, so four of the nine archetypes ignored the
  // theme entirely. Derived words reach these through the chain (#103).
  "door : stroke=#a8763e width=5",
  "window : stroke=#6fa8c9 width=2.5",
  "wall : stroke=#3d3629 width=3",
  "fence : stroke=#8a7a5c width=2 dash=3,3",
  "pillar : fill=#5a5244",
  ...Object.entries(TERRAIN_FILLS).map(([word, fill]) => `${word} : fill=${fill}`),
  ...Object.entries(PATH_STROKES).map(
    ([word, s]) => `${word} : stroke=${s.stroke}${s.dash ? ` dash=${s.dash.replace(" ", ",")}` : ""}`
  ),
  ...Object.entries(SIDE_COLORS).map(([word, fill]) => `side.${word} : fill=${fill}`),
  ""
].join("\n");
var Theme = class _Theme {
  map = /* @__PURE__ */ new Map();
  glyphs = {};
  /**
   * Dead-declaration bookkeeping (#116, ADR 0022). Only the SELECTED theme is
   * recorded: an inherited or built-in theme deliberately styles words no one
   * map uses, so silence there is its normal condition rather than a defect.
   */
  own = [];
  ownGlyphs = {};
  /** Every glyph name any layer's `glyph=`/`asset=` can reach, variant pools split. */
  glyphRefs = /* @__PURE__ */ new Set();
  /** `key\0prop` for every lookup that actually RETURNED a value. */
  hits = /* @__PURE__ */ new Set();
  /** Subjects any lookup resolved to at all, whatever property was wanted. */
  subjectHits = /* @__PURE__ */ new Set();
  merge(doc, selected) {
    for (const entry of doc.entries) {
      const key = entry.sub ? `${entry.base}.${entry.sub}` : entry.base;
      this.map.set(key, { ...this.map.get(key), ...entry.pairs });
      const names = [];
      for (const prop of ["glyph", "asset"]) {
        const value = entry.pairs[prop];
        if (value) for (const name of value.split(",")) names.push(name.trim());
      }
      for (const name of names) this.glyphRefs.add(name);
      if (selected) this.own.push({ key, props: Object.keys(entry.pairs), line: entry.line, names });
    }
    Object.assign(this.glyphs, doc.glyphs);
    if (selected) Object.assign(this.ownGlyphs, doc.glyphLines);
  }
  hit(key, prop) {
    this.hits.add(`${key}\0${prop}`);
    this.subjectHits.add(key);
  }
  /**
   * Build a theme: the default document, then an optional user theme source.
   * A `use: default` inside the user theme is honored (and implicit layering
   * on top of the default applies regardless, per spec 08 §5 selection).
   *
   * The LAST source is the selected theme. That is not a calling convention —
   * spec 08 §5's shadowing requires the theme chosen for this render to be
   * merged last, or its own entries would lose to the ones it inherits.
   */
  static resolve(userSource, diagnostics) {
    const theme = new _Theme();
    theme.merge(parseThemeDocument(DEFAULT_THEME_SOURCE, diagnostics), false);
    const sources = userSource === void 0 ? [] : Array.isArray(userSource) ? userSource : [userSource];
    for (const [i, source] of sources.entries()) {
      const themeDiagnostics = [];
      theme.merge(parseThemeDocument(source, themeDiagnostics), i === sources.length - 1);
      for (const d of themeDiagnostics) diagnostics.push({ ...d, source: "theme" });
    }
    return theme;
  }
  /**
   * Declarations in the selected theme that did nothing (#116). Call AFTER the
   * render, since liveness is measured by what the render actually asked for.
   *
   * An entry is live if any property IT declares was returned to a caller. Per
   * property, not per subject: the default theme and the user's can both carry
   * a `mountain` line, and the merged record holds both their pairs — asking
   * only "was `mountain` touched?" would call a dead `glyph=` live because the
   * default's `fill=` was read.
   */
  deadDeclarations(subjects = /* @__PURE__ */ new Map()) {
    const out = [];
    for (const entry of this.own) {
      if (this.hits.has(`${entry.key}\0*`)) continue;
      if (entry.props.some((prop) => this.hits.has(`${entry.key}\0${prop}`))) continue;
      const resolved = subjects.get(entry.key) ?? 0;
      const isSurface = SURFACE_WORDS.has(entry.key.split(".")[0]);
      const props = entry.props.map((p) => `'${p}'`).join(", ");
      const isAre = entry.props.length === 1 ? "is" : "are";
      out.push({
        line: entry.line,
        message: isSurface ? `'${entry.key}' is a surface, but ${props} ${isAre} not read for it in this render \u2014 nothing written here will reach the map (spec 08 \xA72)` : resolved > 0 ? `'${entry.key}' resolves to ${resolved} ${resolved === 1 ? "entity" : "entities"}, but ${props} ${isAre} not read for ${resolved === 1 ? "it" : "them"} in this render \u2014 nothing written here will reach the map (spec 08 \xA76)` : this.subjectHits.has(entry.key) ? `'${entry.key}' is styled elsewhere, but ${props} on this line ${isAre} never read for it \u2014 the property does not apply to this kind of subject (spec 08 \xA73)` : `'${entry.key}' styles nothing in this document \u2014 no entity resolves to it, so every property on this line is inert (spec 08 \xA75)`
      });
    }
    for (const [name, line] of Object.entries(this.ownGlyphs)) {
      if (this.glyphRefs.has(name)) continue;
      out.push({
        line,
        message: `glyph '${name}' is never referenced by a glyph= or asset= property \u2014 it is defined and unreachable (spec 08 \xA73)`
      });
    }
    for (const entry of this.own) {
      for (const name of entry.names) {
        if (this.glyphs[name] !== void 0) continue;
        out.push({
          line: entry.line,
          message: `'${entry.key}' names the glyph '${name}', which no [glyphs] section defines \u2014 the render falls back to a generic marker (spec 08 \xA74)`
        });
      }
    }
    return out.sort((a, b) => a.line - b.line);
  }
  /** Chain-walking property lookup: word.state > word.zone > word; earlier chain words win. */
  prop(chain, key, ctx = {}) {
    for (const word of chain) {
      const candidates = [
        ctx.state ? `${word}.${ctx.state}` : null,
        ctx.zone ? `${word}.${ctx.zone}` : null,
        word
      ];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const value = this.map.get(candidate)?.[key];
        if (value !== void 0) {
          this.hit(candidate, key);
          return value;
        }
      }
    }
    return void 0;
  }
  surface(name, key, fallback) {
    const value = this.map.get(name)?.[key];
    if (value === void 0) return fallback;
    this.hit(name, key);
    return value;
  }
  terrainFill(chain, ctx = {}) {
    return this.prop(chain, "fill", ctx) ?? "#d8d3c5";
  }
  pathStroke(chain) {
    const stroke = this.prop(chain, "stroke") ?? this.prop(chain, "fill") ?? "#9a917e";
    const dash = this.prop(chain, "dash")?.replace(",", " ");
    return dash ? { stroke, dash } : { stroke };
  }
  /**
   * Which side of its line this word's border lies on (#185, ADR 0034).
   *
   * LAND by default, and the arithmetic is what decides it rather than the
   * convention. A coastline's line is dark ink, not a vignette: at 1.2 units
   * on a 200mi map it spans 0.29mi, so centred it puts 0.146mi into the water
   * from each shore, and two shores 0.20mi apart paint their channel shut
   * between them. Clipped to the WATER it is worse, 0.29mi from each side.
   * Clipped to the land it puts nothing in the water at all, and a channel is
   * drawn exactly as wide as it was declared.
   *
   * That is also spec 08's rule in its strongest form: no stroke paints land
   * colour onto declared water, whatever a theme asks for. A theme that wants
   * the conventional water-side vignette says `bank=water` and colours it from
   * the water — safe, because clipped there it can only ever darken water.
   */
  bank(chain) {
    const declared2 = this.prop(chain, "bank");
    return declared2 === "water" || declared2 === "both" ? declared2 : "land";
  }
  side(word) {
    const fill = word && this.map.get(`side.${word}`)?.["fill"];
    if (!fill) return "#8a6ab5";
    this.hit(`side.${word}`, "fill");
    return fill;
  }
  /**
   * Appearance zones for a chain (spec 08 §2): on an area, blob, or ridge
   * `edge` is the boundary band and `core` the interior; on a path band `edge`
   * is the two side margins and `core` the centre strip.
   *
   * Returns null when the theme declares neither, so a caller can keep its
   * plain single-fill path untouched — which is what every caller did before
   * (#150), leaving one of the four spec'd combinations implemented.
   */
  zones(chain, base) {
    const edge = this.zoneProp(chain, "edge");
    const core = this.zoneProp(chain, "core");
    if (edge === void 0 && core === void 0) return null;
    return { edge: edge ?? base, core: core ?? base, width: this.edgeWidth(chain) ?? 4 };
  }
  /**
   * A zone's colour, and ONLY from a `word.core`/`word.edge` entry.
   *
   * `prop(chain, key, { zone })` deliberately falls back to the bare word, so
   * asking it whether a zone is declared always answers yes for any word with
   * a fill — which made "is this banded?" unanswerable, and would have banded
   * every area on every map the moment a caller started asking (#150).
   */
  zoneProp(chain, zone) {
    for (const word of chain) {
      const record = this.map.get(`${word}.${zone}`);
      const value = record?.["fill"] ?? record?.["stroke"];
      if (value !== void 0) {
        this.hit(`${word}.${zone}`, record?.["fill"] !== void 0 ? "fill" : "stroke");
        return value;
      }
    }
    return void 0;
  }
  /** Edge-zone thickness in px, if the theme styles an edge for this chain. */
  edgeWidth(chain) {
    const styled = chain.find((word) => this.map.has(`${word}.edge`));
    if (styled === void 0) return null;
    this.hit(`${styled}.edge`, "*");
    return Number(this.prop(chain, "edge") ?? 4) || 4;
  }
  /** Deterministic variant-pool pick (spec 08 §4): position hash, not sequence. */
  pickVariant(value, x, y) {
    const pool = value.split(",").map((v) => v.trim()).filter(Boolean);
    if (pool.length <= 1) return pool[0] ?? value;
    let h = 2166136261;
    for (const n of [Math.round(x), Math.round(y)]) {
      h ^= n;
      h = Math.imul(h, 16777619);
    }
    return pool[(h >>> 0) % pool.length];
  }
  glyphFor(chain, x, y, ctx = {}) {
    const named = this.prop(chain, "glyph", ctx);
    if (!named) return null;
    const chosen = this.pickVariant(named, x, y);
    return this.glyphs[chosen] ?? null;
  }
};
function wordTint(word) {
  let h = 0;
  for (let i = 0; i < word.length; i++) h = h * 31 + word.charCodeAt(i) >>> 0;
  const hue = Math.round(h * 137.508 % 360);
  return `hsl(${hue} 32% 55%)`;
}
var tierOf = (word) => word && TIERS[word] || { r: 3, font: 10, weight: "normal" };
var tierFor = (chain) => {
  for (const word of chain) if (TIERS[word]) return TIERS[word];
  return { r: 3, font: 10, weight: "normal" };
};
var hasTierGlyph = (chain) => chain.some((word) => Boolean(TIERS[word]));
var hasBattlemapGlyph = (chain) => chain.some((word) => BATTLEMAP_GLYPHS.has(word));

// packages/render-svg/src/walls.ts
var SIDE_NAME = { n: "north", s: "south", w: "west", e: "east" };
function passesOf(model, typeWord, pairs) {
  return declared(pairs, "passes") ?? model.facetOf(typeWord, "passes") ?? "open";
}
function sightOf(model, typeWord, pairs, passes) {
  return declared(pairs, "sight") ?? model.facetOf(typeWord, "sight") ?? (passes === "open" ? "all" : "none");
}
function declared(pairs, key) {
  const value = pairOf(pairs, key);
  return value !== void 0 && facetAccepts(key, value) ? value : void 0;
}
function barrierSides(model, e) {
  const replaced = /* @__PURE__ */ new Map();
  const details = e.details.filter((d) => model.archetypeOf(d.typeWord) === "barrier");
  if (details.length === 0) return replaced;
  const cells = structureCells(e);
  if (cells.size === 0) return replaced;
  const perimeter = perimeterEdges(cells);
  for (const d of details) {
    const word = d.typeWord;
    for (const p of d.placements) {
      const edge = p.kind === "edge" ? p : p.kind === "relational" && p.form === "at" && p.target.kind === "edge" ? p.target : null;
      if (edge) replaced.set(segKey(edgeSegment(edge.at, edge.dir)), word);
    }
    const sides = new Set(d.flags);
    if (sides.size === 0) continue;
    for (const pe of perimeter) {
      if (!sides.has(SIDE_NAME[pe.dir]) && !sides.has(pe.dir)) continue;
      const address = { kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row };
      replaced.set(segKey(edgeSegment(address, pe.dir)), word);
    }
  }
  return replaced;
}
function collectWalls(model) {
  const sightPassSegs = /* @__PURE__ */ new Set();
  const openingSegs = /* @__PURE__ */ new Set();
  const portals = [];
  const noteOpening = (typeWord, pairs, placements) => {
    if (model.archetypeOf(typeWord) !== "opening") return;
    const passes = passesOf(model, typeWord, pairs);
    const sight = sightOf(model, typeWord, pairs, passes);
    for (const p of placements) {
      if (p.kind !== "edge") continue;
      const seg = edgeSegment(p.at, p.dir);
      openingSegs.add(segKey(seg));
      if (sight === "all") sightPassSegs.add(segKey(seg));
      if (passes !== "open") portals.push({ seg, closed: true });
    }
  };
  for (const e of model.entities) {
    if (e.archetype === "structure") {
      for (const d of e.details) noteOpening(d.typeWord, d.pairs, d.placements);
    } else if (e.archetype === "opening") {
      noteOpening(e.typeWord, e.pairs, e.placements);
    }
  }
  const blockers = [];
  const losWalls = [];
  const push = (seg) => {
    const key = segKey(seg);
    if (sightPassSegs.has(key)) return;
    blockers.push(seg);
    if (!openingSegs.has(key)) losWalls.push(seg);
  };
  for (const e of model.entities) {
    if (e.archetype === "structure") {
      const cells = structureCells(e);
      if (cells.size === 0) continue;
      const ruined = new Set(e.details.filter((d) => d.typeWord === "ruined").flatMap((d) => d.flags));
      const replaced = barrierSides(model, e);
      for (const pe of perimeterEdges(cells)) {
        if (ruined.has(SIDE_NAME[pe.dir]) || ruined.has(pe.dir)) continue;
        const address = { kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row };
        const seg = edgeSegment(address, pe.dir);
        const word = replaced.get(segKey(seg));
        if (word !== void 0 && (model.facetOf(word, "sight") ?? "none") === "all") continue;
        push(seg);
      }
    } else if (e.archetype === "barrier" && !model.chainOf(e.typeWord).includes("fence")) {
      for (const p of e.placements) {
        if (p.kind === "edge") push(edgeSegment(p.at, p.dir));
      }
    }
  }
  const rock = impassableCells(model);
  if (rock.size > 0) {
    for (const pe of perimeterEdges(rock)) {
      const address = { kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row };
      push(edgeSegment(address, pe.dir));
    }
  }
  return { blockers, losWalls, portals };
}
function impassableCells(model) {
  const winner = /* @__PURE__ */ new Map();
  for (const e of model.entities) {
    if (e.archetype !== "terrain" && e.archetype !== "path") continue;
    const impassable = model.chainOf(e.typeWord).includes("earth");
    for (const [key, cell] of surfaceCells(e)) winner.set(key, { cell, impassable });
  }
  const cells = /* @__PURE__ */ new Map();
  for (const [key, w] of winner) if (w.impassable) cells.set(key, w.cell);
  for (const e of model.entities) {
    if (e.archetype !== "structure") continue;
    for (const key of structureCells(e).keys()) cells.delete(key);
  }
  return cells;
}

// packages/render-svg/src/lints.ts
function surfaceByCell(entities, level) {
  const winner = /* @__PURE__ */ new Map();
  for (const e of entities) {
    if (e.level !== level || !laysSurface(e)) continue;
    for (const key of surfaceCells(e).keys()) winner.set(key, e.typeWord ?? "");
  }
  return winner;
}
function laysSurface(e) {
  if (e.archetype === "terrain" || e.archetype === "path") return true;
  if (e.archetype !== "feature") return false;
  return e.placements.some((p) => p.kind === "shape" && p.shape === "path");
}
function coherenceLints(model, level, diagnostics, ctx) {
  const all = ctx?.allEntities ?? model.entities;
  const on = (xs) => xs.filter((x) => x.level === level);
  const structures = on(model.entities.filter((e) => e.archetype === "structure"));
  const surface = surfaceByCell(all, level);
  const rock = impassableCells(model);
  const levelBelow = (() => {
    const i = ctx?.levels.indexOf(level) ?? -1;
    return i >= 0 && i + 1 < ctx.levels.length ? ctx.levels[i + 1] : null;
  })();
  const roomsOn = (lvl) => {
    const cells = /* @__PURE__ */ new Set();
    for (const e of all) {
      if (e.archetype !== "structure" || e.level !== lvl) continue;
      for (const key of structureCells(e).keys()) cells.add(key);
    }
    return cells;
  };
  const roomsHere = roomsOn(level);
  const walkable = (c) => {
    const key = cellKey(c);
    if (roomsHere.has(key)) return true;
    const word = surface.get(key);
    if (word !== void 0) {
      const chain = model.chainOf(word);
      if (chain.includes("terrace")) return true;
      return !chain.includes("air") && !chain.includes("earth");
    }
    if (rock.has(key)) return false;
    return true;
  };
  const openingEdges = [];
  for (const e of on(model.entities)) {
    const collect = (word, placements, owner) => {
      if (model.archetypeOf(word) !== "opening") return;
      if (model.facetOf(word, "passes") === "none") return;
      for (const p of placements) {
        if (p.kind !== "edge" || !p.at || !p.dir) continue;
        openingEdges.push({ e: owner, seg: edgeSegment(p.at, p.dir), at: p.at, dir: p.dir });
      }
    };
    collect(e.typeWord, e.placements, e);
    for (const d of e.details) collect(d.typeWord, d.placements, e);
  }
  for (const o of openingEdges) {
    const owner = structures.find((s) => structureCells(s).has(cellKey({ col: colNum(o.at.col), row: o.at.row })));
    if (!owner) continue;
    const cells = structureCells(owner);
    const far = o.dir === "n" ? { col: colNum(o.at.col), row: o.at.row - 1 } : o.dir === "s" ? { col: colNum(o.at.col), row: o.at.row + 1 } : o.dir === "e" ? { col: colNum(o.at.col) + 1, row: o.at.row } : o.dir === "w" ? { col: colNum(o.at.col) - 1, row: o.at.row } : null;
    if (!far || far.row < 1 || far.col < 1) continue;
    if (cells.has(cellKey(far))) continue;
    if (walkable(far)) continue;
    diagnostics.push({
      severity: "warning",
      line: o.e.line,
      message: `the opening at ${o.at.col}${o.at.row}.${o.dir} leads out onto ground that cannot be walked on \u2014 a door onto solid rock or open air (spec 06 \xA73)`
    });
  }
  const supported = levelBelow === null ? /* @__PURE__ */ new Set() : roomsOn(levelBelow);
  for (const s of structures) {
    if (s.flags.includes("open")) continue;
    for (const key of structureCells(s).keys()) {
      const word = surface.get(key);
      if (word === void 0) continue;
      const chain = model.chainOf(word);
      if (!chain.includes("air")) continue;
      if (supported.has(key)) continue;
      diagnostics.push({
        severity: "warning",
        line: s.line,
        message: `this structure stands on '${word}' with nothing beneath it on level '${levelBelow ?? "(none)"}' \u2014 a building on open air (spec 06 \xA75)`
      });
      break;
    }
  }
  for (const s of structures) {
    const cells = structureCells(s);
    if (cells.size === 0) continue;
    const perimeter = new Set(
      perimeterEdges(cells).map((pe) => segKey(edgeSegment({ kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row }, pe.dir)))
    );
    const hasOpening = openingEdges.some((o) => perimeter.has(segKey(o.seg)));
    const hasConnector = all.some((e) => {
      const to = e.pairs.find((p) => p.key === "to")?.value;
      if (to === void 0) return false;
      const reachesHere = e.level === level || to === level || to.split("..").includes(level);
      if (!reachesHere) return false;
      const atValue = e.pairs.find((p) => p.key === "at")?.value;
      const landing = atValue ?? null;
      const addresses = e.placements.filter((p) => p.kind === "address");
      const targets = landing ? [landing] : addresses.map((a) => `${a.col}${a.row}`);
      return targets.some((t) => {
        const m = /^([A-Z]+)(\d+)$/.exec(t);
        return m !== null && cells.has(cellKey({ col: colNum(m[1]), row: Number(m[2]) }));
      });
    });
    if (!hasOpening && !hasConnector) {
      diagnostics.push({
        severity: "warning",
        line: s.line,
        message: `this structure has no opening and no connector inside it \u2014 nothing can reach it (spec 06 \xA73)`
      });
    }
  }
  for (const e of on(model.entities)) {
    const to = e.pairs.find((p) => p.key === "to")?.value;
    if (to === void 0 || to.includes("..")) continue;
    const landing = e.placements.find((p) => p.kind === "address");
    if (!landing) continue;
    const key = cellKey({ col: colNum(landing.col), row: landing.row });
    if (roomsOn(to).has(key)) continue;
    const word = surfaceByCell(all, to).get(key);
    if (word === void 0) continue;
    const chain = model.chainOf(word);
    if (chain.includes("terrace") || !chain.includes("air") && !chain.includes("earth")) continue;
    diagnostics.push({
      severity: "warning",
      line: e.line,
      message: `this connector lands on '${word}' on level '${to}', which cannot be stood on (spec 06 \xA78)`
    });
  }
  for (let i = 0; i < structures.length; i++) {
    for (let j = i + 1; j < structures.length; j++) {
      const a = structureCells(structures[i]);
      const b = structureCells(structures[j]);
      const shared = [...a.keys()].filter((k) => b.has(k)).length;
      if (shared === 0) continue;
      if (shared === a.size || shared === b.size) continue;
      diagnostics.push({
        severity: "warning",
        line: structures[j].line,
        message: `two structures on this level share cells \u2014 their walls and UVTT line_of_sight are drawn twice (spec 06 \xA73)`
      });
    }
  }
  const openingSegs = new Set(openingEdges.map((o) => segKey(o.seg)));
  for (const s of structures) {
    const cells = structureCells(s);
    if (cells.size === 0) continue;
    for (const t of on(model.entities)) {
      if (t.archetype !== "terrain" && t.archetype !== "path") continue;
      const tc = surfaceCells(t);
      if (tc.size === 0) continue;
      const inside = [...tc.keys()].filter((k) => cells.has(k)).length;
      if (inside === 0) continue;
      if (inside === tc.size) continue;
      if (inside === cells.size) continue;
      const crossings = /* @__PURE__ */ new Set();
      for (const [key, c] of cells) {
        if (!tc.has(key)) continue;
        const sides = [
          ["n", { col: c.col, row: c.row - 1 }],
          ["s", { col: c.col, row: c.row + 1 }],
          ["e", { col: c.col + 1, row: c.row }],
          ["w", { col: c.col - 1, row: c.row }]
        ];
        for (const [dir, n] of sides) {
          const nk = cellKey(n);
          if (cells.has(nk) || !tc.has(nk)) continue;
          crossings.add(segKey(edgeSegment({ kind: "address", col: colLetters(c.col), row: c.row }, dir)));
        }
      }
      if (crossings.size > 0 && [...crossings].every((k) => openingSegs.has(k))) continue;
      diagnostics.push({
        severity: "warning",
        line: t.line,
        message: `'${t.typeWord ?? "terrain"}' runs both inside and outside a structure's footprint, crossing its wall where there is no opening \u2014 terrain that stays wholly inside a room (a pool, a dais) is fine, as is terrain that crosses at a door (spec 06 \xA76)`
      });
      break;
    }
  }
}
var colNum = (letters) => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};

// packages/render-svg/src/battlemap.ts
function battlemapFrame(model) {
  const cols = model.doc.grid?.cols ?? 20;
  const rows = model.doc.grid?.rows ?? 15;
  return { cols, rows, w: MARGIN * 2 + cols * CELL, h: MARGIN * 2 + rows * CELL };
}
function renderBattlemap(model, body, frame, diagnostics, levelCtx) {
  const layers = {
    areas: [],
    paths: [],
    crossings: [],
    grid: [],
    structures: [],
    openings: [],
    roomLabels: [],
    features: [],
    zones: [],
    tokens: [],
    labels: []
  };
  const fieldHoles = /* @__PURE__ */ new Map();
  const noteHole = (field, shape) => {
    const list = fieldHoles.get(field) ?? [];
    list.push(shape);
    fieldHoles.set(field, list);
  };
  let noteCourseCount = 0;
  let openEdgeCache = null;
  const openingEdgeKeys = () => {
    if (openEdgeCache) return openEdgeCache;
    const keys = /* @__PURE__ */ new Set();
    for (const e of model.entities) {
      if (e.archetype !== "structure") continue;
      for (const d of e.details) {
        if (model.archetypeOf(d.typeWord) !== "opening") continue;
        for (const p of d.placements) {
          if (p.kind === "edge") keys.add(segKey(edgeSegment(p.at, p.dir)));
        }
      }
    }
    openEdgeCache = keys;
    return keys;
  };
  const pathRecords = [];
  const crossingCells = /* @__PURE__ */ new Set();
  const pendingCrossings = [];
  const sightBlockers = collectWalls(model).blockers;
  const labelObstructions = [];
  for (const e of model.entities) {
    if (e.archetype === "feature") {
      for (const p of e.placements) {
        if (p.kind === "address") {
          const o = cellOrigin(p);
          labelObstructions.push({ x: o.x, y: o.y, w: CELL, h: CELL });
        } else if (p.kind === "range" && !e.gmOnly && pairOf(e.pairs, "elevation") === void 0) {
          labelObstructions.push(rangeRect(p));
        }
      }
    } else if (e.archetype === "token" && !hasOnlyRange(e)) {
      const size = Number(pairOf(e.pairs, "size") ?? 1) || 1;
      for (const p of e.placements) {
        if (p.kind !== "address") continue;
        const o = cellOrigin(p);
        labelObstructions.push({ x: o.x, y: o.y, w: CELL * size, h: CELL * size });
      }
    }
  }
  body.push(
    `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0,6 L6,0" stroke="#7a7264" stroke-width="1" opacity="0.5"/></pattern></defs>`
  );
  for (const e of model.entities) {
    const anchor = anchorAttr(model, e);
    const title = [gmTitleFor(model, e), model.resolvedNotes.get(e)].filter(Boolean).join(" \u2014 ");
    const titleEl = title ? svgTitle(title) : "";
    const elevation = pairOf(e.pairs, "elevation");
    if (model.chainOf(e.typeWord).includes("note")) {
      renderFreeText(e, layers.labels, titleEl, anchor);
      continue;
    }
    if (e.section === "terrain") {
      const chain = model.chainOf(e.typeWord);
      if (chain.includes("ford") || chain.includes("bridge")) {
        pendingCrossings.push({ e, chain, titleEl, anchor });
      } else {
        renderTerrain(e, titleEl, anchor);
      }
      continue;
    }
    if (e.archetype === "structure") {
      renderStructure(e, layers.structures, titleEl, anchor);
      continue;
    }
    if (e.archetype === "opening") {
      renderUnparentedOpening(e, titleEl, anchor);
      continue;
    }
    if (e.archetype === "barrier") {
      renderBarrier(e, layers.structures, titleEl, anchor);
      continue;
    }
    const zoneLike = e.archetype === "zone" || hasOnlyRange(e) && (e.gmOnly || elevation !== void 0);
    if (zoneLike) {
      renderZone(e, layers.zones, layers.roomLabels, titleEl, anchor, elevation);
      continue;
    }
    if (e.archetype === "token") {
      renderToken(e, layers.tokens, layers.labels, titleEl, anchor);
      continue;
    }
    renderFeature(e, layers.features, layers.labels, titleEl, anchor);
  }
  const f = frame;
  for (let c = 0; c <= f.cols; c++) {
    const x = MARGIN + c * CELL;
    layers.grid.push(el("line", { x1: x, y1: MARGIN, x2: x, y2: MARGIN + f.rows * CELL, stroke: model.theme.surface("grid", "stroke", GRID_LINE), "stroke-width": 0.6 }));
  }
  for (let r = 0; r <= f.rows; r++) {
    const y = MARGIN + r * CELL;
    layers.grid.push(el("line", { x1: MARGIN, y1: y, x2: MARGIN + f.cols * CELL, y2: y, stroke: model.theme.surface("grid", "stroke", GRID_LINE), "stroke-width": 0.6 }));
  }
  if (model.header.get("numbers") === "on") {
    for (let c = 1; c <= f.cols; c++) {
      layers.grid.push(text(colLetters(c), { x: MARGIN + (c - 0.5) * CELL, y: MARGIN - 7, "font-size": 9, fill: "#8a8272", "text-anchor": "middle", "font-family": "sans-serif" }));
    }
    for (let r = 1; r <= f.rows; r++) {
      layers.grid.push(text(String(r), { x: MARGIN - 7, y: MARGIN + (r - 0.5) * CELL + 3, "font-size": 9, fill: "#8a8272", "text-anchor": "end", "font-family": "sans-serif" }));
    }
  }
  for (const pending of pendingCrossings) renderCrossing(pending);
  coherenceLints(model, levelCtx?.level ?? model.doc.defaultLevel, diagnostics, levelCtx);
  if (levelCtx) {
    for (const source of levelCtx.allEntities) {
      const to = pairOf(source.pairs, "to");
      if (to === void 0 || source.level === levelCtx.level) continue;
      const lands = levelSpan(levelCtx.levels, to).includes(levelCtx.level);
      const throughValue = pairOf(source.pairs, "through");
      const passes = throughValue !== void 0 && levelSpan(levelCtx.levels, throughValue).includes(levelCtx.level);
      if (passes) {
        const atV = pairOf(source.pairs, "at");
        const shaftAt = atV ? parseCell(atV) : source.placements.find((p) => p.kind === "address");
        if (shaftAt) renderShaft(cellCenter(shaftAt), layers.features);
        continue;
      }
      if (!lands) continue;
      const atValue = pairOf(source.pairs, "at");
      const landing = atValue ? parseCell(atValue) : source.placements.find((p) => p.kind === "address");
      if (!landing) continue;
      const occupied = model.entities.some(
        (e) => pairOf(e.pairs, "to") !== void 0 && e.placements.some((p) => p.kind === "address" && p.col === landing.col && p.row === landing.row)
      );
      if (occupied) continue;
      const c = cellCenter(landing);
      renderConnector(source, model.chainOf(source.typeWord), c, source.level, [], layers.features, void 0);
    }
  }
  for (const water of pathRecords.filter((p) => p.isWater)) {
    for (const road of pathRecords.filter((p) => p.isRoad)) {
      const uncovered = [...water.cells].filter((c) => road.cells.has(c) && !crossingCells.has(c));
      if (uncovered.length > 0) {
        const [col, row] = uncovered[0].split(":").map(Number);
        const waterName = water.e.name ?? water.e.typeWord ?? "water";
        const roadName = road.e.name ?? road.e.typeWord ?? "road";
        diagnostics.push({
          severity: "warning",
          line: road.e.line,
          message: `'${roadName}' crosses '${waterName}' at ${colLetters(col)}${row} with no ford or bridge \u2014 the render implies one (spec 06 \xA76)`
        });
      }
    }
  }
  body.push(
    ...layers.areas,
    ...layers.paths,
    ...layers.crossings,
    ...layers.grid,
    ...layers.structures,
    ...layers.openings,
    ...layers.roomLabels,
    ...layers.zones,
    ...layers.features,
    ...layers.tokens
  );
  body.push(...ambientWash());
  body.push(...layers.labels);
  function ambientOf(field) {
    const level = levelCtx?.level;
    let general;
    for (const h of model.doc.header) {
      if (h.key !== field) continue;
      if (h.qualifier === void 0) general = h.value;
      else if (level !== void 0 && h.qualifier === level) return h.value;
    }
    return general;
  }
  function emitterHole(at, radius) {
    const occluded = model.facetOf("light", "occluded") ?? "sight";
    if (occluded !== "none" && sightBlockers.length > 0) {
      return el("polygon", { points: pointsAttr(visibilityPolygon(at, radius, sightBlockers)), fill: "#000" });
    }
    return el("circle", { cx: at.x, cy: at.y, r: radius, fill: "#000" });
  }
  function ambientWash() {
    const out = [];
    const fields = new Set(model.doc.header.filter((h) => model.archetypeOf(h.key) === "field").map((h) => h.key));
    for (const field of fields) {
      const value = ambientOf(field);
      if (value === void 0) continue;
      const fill = model.theme.prop(model.chainOf(field), "fill", { state: value });
      if (!fill) continue;
      const opacity = model.theme.prop(model.chainOf(field), "opacity", { state: value }) ?? "0.82";
      const holes = fieldHoles.get(field) ?? [];
      const id = `cdfield-${model.doc.docId}-${field}${levelCtx?.level ? `-${levelCtx.level}` : ""}`;
      out.push(
        `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${fmt(frame.w)}" height="${fmt(frame.h)}">` + el("rect", { x: 0, y: 0, width: frame.w, height: frame.h, fill: "#fff" }) + holes.join("") + `</mask></defs>` + el("rect", { x: 0, y: 0, width: frame.w, height: frame.h, fill, opacity, mask: `url(#${id})` })
      );
    }
    return out;
  }
  function cellsAlong(pts) {
    const cells = /* @__PURE__ */ new Set();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 4)));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + (b.x - a.x) * s / steps;
        const y = a.y + (b.y - a.y) * s / steps;
        const col = Math.floor((x - MARGIN) / CELL) + 1;
        const row = Math.floor((y - MARGIN) / CELL) + 1;
        if (col >= 1 && col <= frame.cols && row >= 1 && row <= frame.rows) cells.add(`${col}:${row}`);
      }
    }
    return cells;
  }
  function entityCells(e) {
    const out = [];
    for (const p of e.placements) {
      if (p.kind === "address") out.push({ col: colToNumber2(p.col), row: p.row });
      else if (p.kind === "range") {
        const c1 = colToNumber2(p.from.col);
        const c2 = colToNumber2(p.to.col);
        for (let col = Math.min(c1, c2); col <= Math.max(c1, c2); col++) {
          for (let row = Math.min(p.from.row, p.to.row); row <= Math.max(p.from.row, p.to.row); row++) {
            out.push({ col, row });
          }
        }
      }
    }
    return out;
  }
  function bandCells(record) {
    const half = record.width / 2 + 1;
    const cells = /* @__PURE__ */ new Set();
    for (let col = 1; col <= frame.cols; col++) {
      for (let row = 1; row <= frame.rows; row++) {
        const center = { x: MARGIN + (col - 0.5) * CELL, y: MARGIN + (row - 0.5) * CELL };
        const nearest = nearestOnPolyline(record.pts, center);
        if (Math.hypot(nearest.x - center.x, nearest.y - center.y) <= half) cells.add(`${col}:${row}`);
      }
    }
    return cells;
  }
  function connectedClusters(keys) {
    const remaining = new Set(keys);
    const clusters = [];
    while (remaining.size > 0) {
      const seed = remaining.values().next().value;
      const queue = [seed];
      remaining.delete(seed);
      const cluster = [];
      while (queue.length > 0) {
        const key = queue.pop();
        cluster.push(key);
        const [col, row] = key.split(":").map(Number);
        for (let dc = -1; dc <= 1; dc++) {
          for (let dr = -1; dr <= 1; dr++) {
            const neighbor = `${col + dc}:${row + dr}`;
            if (remaining.has(neighbor)) {
              remaining.delete(neighbor);
              queue.push(neighbor);
            }
          }
        }
      }
      clusters.push(cluster.sort());
    }
    return clusters.sort((a, b) => a[0] < b[0] ? -1 : 1);
  }
  function renderCrossing(pending) {
    const { e, chain, titleEl, anchor } = pending;
    const isBridge = chain.includes("bridge");
    const findRecord = (ref) => pathRecords.find((p) => ref.form === "id" ? p.e.ids.includes(ref.value) : p.e.name === ref.value);
    const onRefs = e.placements.filter(
      (p) => p.kind === "relational" && p.form === "on"
    );
    const atCell = e.placements.find(
      (p) => p.kind === "relational" && p.form === "at"
    )?.target ?? onRefs.map((p) => p.at).find((a) => a?.kind === "address");
    let cells = [];
    let host;
    if (onRefs.length >= 2) {
      const records = onRefs.map((p) => findRecord(p.ref)).filter((r) => r !== void 0);
      if (records.length >= 2) {
        const water2 = records.find((r) => r.isWater) ?? records[0];
        const other = records.find((r) => r !== water2);
        const intersection = new Set([...bandCells(water2)].filter((c) => bandCells(other).has(c)));
        const clusters = connectedClusters(intersection);
        let chosen = clusters;
        if (clusters.length > 1) {
          if (atCell?.kind === "address") {
            const key = `${colToNumber2(atCell.col)}:${atCell.row}`;
            const match = clusters.find((cluster) => cluster.includes(key));
            chosen = match ? [match] : clusters;
          }
          if (chosen.length > 1) {
            diagnostics.push({
              severity: "error",
              line: e.line,
              message: `'${e.typeWord}' on '${water2.e.name ?? water2.e.typeWord}' and '${other.e.name ?? other.e.typeWord}' is ambiguous \u2014 they cross at ${clusters.map((c) => cellName(c[0])).join(" and ")}; add 'at <cell>' to choose (spec 06 \xA76)`
            });
          }
        }
        cells = chosen.flat().map((key) => {
          const [col, row] = key.split(":").map(Number);
          return { col, row };
        });
        host = isBridge ? records.find((r) => r.isRoad) ?? other : water2;
      }
    }
    if (cells.length === 0) {
      cells = entityCells(e);
      const cellKeys2 = new Set(cells.map((c) => `${c.col}:${c.row}`));
      host = pathRecords.find((p) => (isBridge ? p.isRoad : p.isWater) && [...p.cells].some((c) => cellKeys2.has(c)));
    }
    for (const c of cells) crossingCells.add(`${c.col}:${c.row}`);
    const parts = [titleEl];
    const derivedRecords = onRefs.map((p) => findRecord(p.ref)).filter((r) => r !== void 0);
    const water = derivedRecords.find((r) => r.isWater);
    const roadRec = derivedRecords.find((r) => r.isRoad);
    if (water && roadRec) {
      const hostRec = isBridge ? roadRec : water;
      const clipRec = isBridge ? water : roadRec;
      const clipId = `xing-${e.line}`;
      parts.push(`<clipPath id="${clipId}">${bandQuads(clipRec)}</clipPath>`);
      const scope = [];
      const band = (stroke, width) => el("polyline", {
        points: pointsAttr(hostRec.pts),
        fill: "none",
        stroke,
        "stroke-width": width,
        "stroke-linecap": "butt",
        "stroke-linejoin": "round",
        "clip-path": `url(#${clipId})`
      });
      if (isBridge) {
        scope.push(band("#6b4a26", hostRec.width + 6));
        scope.push(band("#a8763e", hostRec.width));
      } else {
        scope.push(band("#c2d4dc", hostRec.width));
        if (e.flags.includes("difficult")) scope.push(band("url(#hatch)", hostRec.width));
      }
      if (atCell?.kind === "address" && cells.length > 0) {
        const outerId = `xing-scope-${e.line}`;
        const pad = CELL;
        const rects = cells.map(
          (c) => el("rect", {
            x: MARGIN + (c.col - 1) * CELL - pad,
            y: MARGIN + (c.row - 1) * CELL - pad,
            width: CELL + 2 * pad,
            height: CELL + 2 * pad
          })
        ).join("");
        parts.push(`<clipPath id="${outerId}">${rects}</clipPath>`);
        parts.push(`<g clip-path="url(#${outerId})">${scope.join("")}</g>`);
      } else {
        parts.push(...scope);
      }
    } else if (host && cells.length > 0) {
      const clipId = `xing-${e.line}`;
      const clipRects = cells.map(
        (c) => el("rect", { x: MARGIN + (c.col - 1) * CELL, y: MARGIN + (c.row - 1) * CELL, width: CELL, height: CELL })
      ).join("");
      parts.push(`<clipPath id="${clipId}">${clipRects}</clipPath>`);
      const band = (stroke, width) => el("polyline", {
        points: pointsAttr(host.pts),
        fill: "none",
        stroke,
        "stroke-width": width,
        "stroke-linecap": "butt",
        "stroke-linejoin": "round",
        "clip-path": `url(#${clipId})`
      });
      if (isBridge) {
        parts.push(band("#6b4a26", host.width + 6));
        parts.push(band("#a8763e", host.width));
      } else {
        parts.push(band("#c2d4dc", host.width));
        if (e.flags.includes("difficult")) parts.push(band("url(#hatch)", host.width));
      }
    } else {
      for (const { col, row } of cells) {
        const x = MARGIN + (col - 1) * CELL;
        const y = MARGIN + (row - 1) * CELL;
        parts.push(el("rect", { x, y, width: CELL, height: CELL, fill: isBridge ? "#a8763e" : "#c2d4dc", opacity: 0.95 }));
        if (!isBridge && e.flags.includes("difficult")) parts.push(el("rect", { x, y, width: CELL, height: CELL, fill: "url(#hatch)" }));
      }
    }
    layers.crossings.push(el("g", { id: anchor }, ...parts));
  }
  function cellName(key) {
    const [col, row] = key.split(":").map(Number);
    return `${colLetters(col)}${row}`;
  }
  function parseCell(value) {
    const m = /^([A-Z]+)(\d+)$/.exec(value);
    return m ? { kind: "address", col: m[1], row: Number(m[2]) } : null;
  }
  function dropEdge(r) {
    const ink = model.theme.surface("ledge", "stroke", "#6b5d4a");
    const parts = [
      el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: "none", stroke: ink, "stroke-width": 2, class: "drop" })
    ];
    const tick = 4;
    for (let x = r.x + 5; x < r.x + r.w; x += 9) {
      parts.push(el("line", { x1: x, y1: r.y, x2: x - 2, y2: r.y - tick, stroke: ink, "stroke-width": 1.2 }));
      parts.push(el("line", { x1: x, y1: r.y + r.h, x2: x - 2, y2: r.y + r.h + tick, stroke: ink, "stroke-width": 1.2 }));
    }
    for (let y = r.y + 5; y < r.y + r.h; y += 9) {
      parts.push(el("line", { x1: r.x, y1: y, x2: r.x - tick, y2: y - 2, stroke: ink, "stroke-width": 1.2 }));
      parts.push(el("line", { x1: r.x + r.w, y1: y, x2: r.x + r.w + tick, y2: y - 2, stroke: ink, "stroke-width": 1.2 }));
    }
    return el("g", {}, ...parts);
  }
  function renderShaft(c, into) {
    const ink = model.theme.surface("ink", "fill", INK);
    const half = CELL * 0.42;
    into.push(
      el("rect", {
        x: c.x - half,
        y: c.y - half,
        width: half * 2,
        height: half * 2,
        fill: "none",
        stroke: ink,
        "stroke-width": 1.6
      }),
      el("line", { x1: c.x - half, y1: c.y - half, x2: c.x + half, y2: c.y + half, stroke: ink, "stroke-width": 1 }),
      el("line", { x1: c.x + half, y1: c.y - half, x2: c.x - half, y2: c.y + half, stroke: ink, "stroke-width": 1 })
    );
  }
  function levelSpan(levels, value) {
    const [a, b] = value.split("..");
    if (b === void 0) return levels.includes(a) ? [a] : [];
    const i = levels.indexOf(a);
    const j = levels.indexOf(b);
    if (i === -1 || j === -1) return [];
    return levels.slice(Math.min(i, j), Math.max(i, j) + 1);
  }
  function nextLandingIndex(levels, span, from) {
    let best = -1;
    for (const name of span) {
      const idx = levels.indexOf(name);
      if (idx === -1 || idx === from) continue;
      if (best === -1 || Math.abs(idx - from) < Math.abs(best - from)) best = idx;
    }
    return best;
  }
  function renderConnector(e, chain, c, to, parts, into, anchor) {
    if (!levelCtx) return;
    const currentIdx = levelCtx.levels.indexOf(levelCtx.level);
    const span = levelSpan(levelCtx.levels, to);
    const targetIdx = span.length > 1 ? nextLandingIndex(levelCtx.levels, span, currentIdx) : levelCtx.levels.indexOf(to);
    const up = targetIdx !== -1 && targetIdx < currentIdx;
    const shown = levelCtx.levels[targetIdx] ?? to;
    const ink = model.theme.surface("ink", "fill", INK);
    const themed = model.theme.glyphFor(chain, c.x, c.y, { state: up ? "up" : "down" }) ?? model.theme.glyphFor(chain, c.x, c.y);
    if (themed) {
      parts.push(
        `<path d="${themed}" transform="translate(${fmt(c.x)} ${fmt(c.y)}) scale(0.9)" fill="none" stroke="${ink}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`
      );
    } else {
      for (let i = 0; i < 3; i++) {
        const half = 10 - i * 3;
        const y = c.y + (up ? 6 - i * 6 : -6 + i * 6);
        parts.push(el("line", { x1: c.x - half, y1: y, x2: c.x + half, y2: y, stroke: ink, "stroke-width": 2.2 }));
      }
    }
    parts.push(
      text(`${up ? "\u25B2" : "\u25BC"} ${to}`, {
        x: c.x,
        y: c.y + CELL * 0.72,
        "font-size": 7.5,
        fill: ink,
        "text-anchor": "middle",
        "font-family": "sans-serif"
      })
    );
    into.push(el("g", { id: anchor }, ...parts));
  }
  function bandQuads(record) {
    const half = record.width / 2;
    const quads = [];
    for (let i = 0; i < record.pts.length - 1; i++) {
      const a = record.pts[i];
      const b = record.pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * half;
      const ny = dx / len * half;
      quads.push(
        el("polygon", {
          points: pointsAttr([
            { x: a.x + nx, y: a.y + ny },
            { x: b.x + nx, y: b.y + ny },
            { x: b.x - nx, y: b.y - ny },
            { x: a.x - nx, y: a.y - ny }
          ])
        })
      );
    }
    return quads.join("");
  }
  function renderTerrain(e, titleEl, anchor) {
    const chain = model.chainOf(e.typeWord);
    const fill = model.theme.terrainFill(chain);
    const zones = model.theme.zones(chain, fill);
    const bandRect = (r) => {
      if (!zones) return el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill });
      const inset = Math.min(zones.width, r.w / 2, r.h / 2);
      return el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: zones.edge }) + el("rect", { x: r.x + inset, y: r.y + inset, width: r.w - 2 * inset, height: r.h - 2 * inset, fill: zones.core });
    };
    const areaParts = [];
    let fellAnnotated = false;
    const pathParts = [];
    for (const p of e.placements) {
      if (p.kind === "shape" && p.shape === "area") {
        for (const arg of p.args) {
          if (arg.kind === "range") {
            const r = rangeRect(arg);
            areaParts.push(bandRect(r));
            if (e.flags.includes("difficult")) areaParts.push(el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: "url(#hatch)" }));
            if (e.flags.includes("drop")) areaParts.push(dropEdge(r));
            const fallsTo = pairOf(e.pairs, "to");
            if (fallsTo !== void 0 && model.chainOf(e.typeWord).includes("air") && !fellAnnotated) {
              fellAnnotated = true;
              areaParts.push(
                text(`\u25BC falls to ${fallsTo}`, {
                  x: r.x + r.w / 2,
                  y: r.y + r.h / 2,
                  "font-size": 8,
                  fill: model.theme.surface("ledge", "stroke", "#6b5d4a"),
                  "text-anchor": "middle",
                  "font-style": "italic",
                  "font-family": "sans-serif"
                })
              );
            }
          } else if (arg.kind === "address") {
            const o = cellOrigin(arg);
            areaParts.push(bandRect({ x: o.x, y: o.y, w: CELL, h: CELL }));
          }
        }
      } else if (p.kind === "shape" && p.shape === "path") {
        const addresses = p.args.filter((a) => a.kind === "address");
        const pts = addresses.map(cellCenter);
        const drawn = extendToCellEdge(pts);
        const width = Number(pairOf(e.pairs, "width") ?? 1) * CELL * 0.85;
        const stroke = model.theme.pathStroke(chain);
        const bandStroke = chain.includes("river") ? model.theme.terrainFill(["sea"]) : stroke.stroke;
        const pathZones = model.theme.zones(chain, bandStroke);
        if (pathZones) {
          pathParts.push(el("polyline", { points: pointsAttr(drawn), fill: "none", stroke: pathZones.edge, "stroke-width": width, "stroke-linecap": "butt", "stroke-linejoin": "round" }));
          const coreWidth = Math.max(width - 2 * pathZones.width, 1);
          pathParts.push(el("polyline", { points: pointsAttr(drawn), fill: "none", stroke: pathZones.core, "stroke-width": coreWidth, "stroke-linecap": "butt", "stroke-linejoin": "round" }));
        } else {
          pathParts.push(el("polyline", { points: pointsAttr(drawn), fill: "none", stroke: bandStroke, "stroke-width": width, "stroke-linecap": "butt", "stroke-linejoin": "round" }));
        }
        pathRecords.push({ e, cells: cellsAlong(pts), isWater: chain.includes("river"), isRoad: chain.includes("road"), pts, width });
      } else if (p.kind === "range") {
        const r = rangeRect(p);
        areaParts.push(el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill, opacity: 0.85 }));
        if (e.flags.includes("difficult")) areaParts.push(el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: "url(#hatch)" }));
        if (e.flags.includes("drop")) areaParts.push(dropEdge(r));
      } else if (p.kind === "address") {
        const o = cellOrigin(p);
        areaParts.push(el("rect", { x: o.x, y: o.y, width: CELL, height: CELL, fill }));
      }
    }
    if (areaParts.length > 0) layers.areas.push(el("g", { id: pathParts.length === 0 ? anchor : void 0 }, titleEl, ...areaParts));
    if (pathParts.length > 0) layers.paths.push(el("g", { id: anchor }, titleEl, ...pathParts));
  }
  function renderStructure(e, into, titleEl, anchor) {
    const cells = structureCells(e);
    if (cells.size === 0) return;
    const open = e.flags.includes("open");
    const fill = model.theme.prop(model.chainOf(e.typeWord), "fill", open ? { state: "open" } : {}) ?? "#efe9da";
    let colMin = Infinity, colMax = -Infinity, rowMin = Infinity, rowMax = -Infinity;
    for (const c of cells.values()) {
      colMin = Math.min(colMin, c.col);
      colMax = Math.max(colMax, c.col);
      rowMin = Math.min(rowMin, c.row);
      rowMax = Math.max(rowMax, c.row);
    }
    const isRect = cells.size === (colMax - colMin + 1) * (rowMax - rowMin + 1);
    const parts = [titleEl];
    if (isRect) {
      const r = { x: MARGIN + (colMin - 1) * CELL, y: MARGIN + (rowMin - 1) * CELL, w: (colMax - colMin + 1) * CELL, h: (rowMax - rowMin + 1) * CELL };
      parts.push(el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill, opacity: 0.8 }));
    } else {
      const d = [...cells.values()].sort((a, b) => a.row - b.row || a.col - b.col).map((c) => `M${fmt(MARGIN + (c.col - 1) * CELL)} ${fmt(MARGIN + (c.row - 1) * CELL)}h${CELL}v${CELL}h-${CELL}Z`).join("");
      parts.push(el("path", { d, fill, opacity: 0.8 }));
    }
    const ruinedSides = new Set(e.details.filter((d) => d.typeWord === "ruined").flatMap((d) => d.flags));
    const ruinedAll = e.flags.includes("ruined");
    const openEdges = openingEdgeKeys();
    const solidEdges = perimeterEdges(cells).filter((pe) => {
      const address = { kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row };
      return !openEdges.has(segKey(edgeSegment(address, pe.dir)));
    });
    const replacedEdges = barrierSides(model, e);
    const ownEdges = solidEdges.filter((pe) => {
      const address = { kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row };
      return !replacedEdges.has(segKey(edgeSegment(address, pe.dir)));
    });
    const structChain = model.chainOf(e.typeWord);
    const wallCtx = open ? { state: "open" } : {};
    const wallStroke = model.theme.prop(structChain, "stroke", wallCtx) ?? INK;
    const wallWidth = Number(model.theme.prop(structChain, "width", wallCtx) ?? 3) || 3;
    for (const word of new Set(replacedEdges.values())) {
      const mine = solidEdges.filter((pe) => {
        const address = { kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row };
        return replacedEdges.get(segKey(edgeSegment(address, pe.dir))) === word;
      });
      const chain = model.chainOf(word);
      const stroke = model.theme.prop(chain, "stroke", {}) ?? INK;
      const width = Number(model.theme.prop(chain, "width", {}) ?? 3) || 3;
      const dash = model.theme.prop(chain, "dash", {})?.replace(",", " ");
      for (const run of mergeEdgeRuns(mine)) {
        parts.push(
          el("line", {
            x1: run.x1,
            y1: run.y1,
            x2: run.x2,
            y2: run.y2,
            stroke,
            "stroke-width": width,
            "stroke-dasharray": dash
          })
        );
      }
    }
    for (const run of mergeEdgeRuns(ownEdges)) {
      const ruined = ruinedAll || ruinedSides.has(SIDE_NAME[run.dir]) || ruinedSides.has(run.dir);
      const ruinedStroke = ruined ? model.theme.prop(structChain, "stroke", { state: "ruined" }) : void 0;
      const ruinedDash = ruined ? model.theme.prop(structChain, "dash", { state: "ruined" })?.replace(",", " ") : void 0;
      parts.push(
        el("line", {
          x1: run.x1,
          y1: run.y1,
          x2: run.x2,
          y2: run.y2,
          stroke: ruinedStroke ?? wallStroke,
          "stroke-width": wallWidth,
          "stroke-dasharray": ruined ? ruinedDash ?? "5 6" : model.theme.prop(structChain, "dash", wallCtx)?.replace(",", " "),
          opacity: ruined ? 0.7 : 1
        })
      );
    }
    for (const d of e.details) {
      for (const p of d.placements) {
        if (p.kind !== "edge") continue;
        const o = cellOrigin(p.at);
        const seg = p.dir === "n" ? { x1: o.x, y1: o.y, x2: o.x + CELL, y2: o.y } : p.dir === "s" ? { x1: o.x, y1: o.y + CELL, x2: o.x + CELL, y2: o.y + CELL } : p.dir === "w" ? { x1: o.x, y1: o.y, x2: o.x, y2: o.y + CELL } : { x1: o.x + CELL, y1: o.y, x2: o.x + CELL, y2: o.y + CELL };
        const openingChain = model.chainOf(d.typeWord);
        if (model.archetypeOf(d.typeWord) !== "opening") {
          parts.push(el("line", { ...seg, stroke: model.theme.prop(openingChain, "stroke") ?? INK, "stroke-width": 3 }));
          continue;
        }
        const windowLike = openingChain.includes("window") || openingChain.includes("arrow-slit");
        const stroke = model.theme.prop(openingChain, "stroke") ?? (windowLike ? "#6fa8c9" : "#a8763e");
        const width = Number(model.theme.prop(openingChain, "width") ?? (windowLike ? 2.5 : 5)) || (windowLike ? 2.5 : 5);
        const ruinedOpening = d.flags.includes("ruined");
        layers.openings.push(el("line", {
          ...seg,
          stroke,
          "stroke-width": width,
          "stroke-dasharray": ruinedOpening ? "4 4" : void 0,
          opacity: ruinedOpening ? 0.6 : void 0
        }));
        layers.openings.push(...openingStateMarks(
          d,
          { a: { x: seg.x1, y: seg.y1 }, b: { x: seg.x2, y: seg.y2 } },
          stroke,
          width,
          model.theme.surface("paper", "fill", PAPER)
        ));
      }
    }
    into.push(el("g", { id: anchor }, ...parts));
    if (e.name && !e.flags.includes("nolabel") && labelsOn(model)) {
      const lbl = labelTextFor(model, e);
      if (lbl !== null) {
        const at = placeRoomLabel(lbl, cells);
        layers.roomLabels.push(
          text(lbl, {
            x: at.x,
            y: at.y,
            "font-size": 10,
            fill: INK,
            "font-weight": model.labelsMode === "keyed" ? "bold" : void 0,
            opacity: 0.8,
            "text-anchor": "middle",
            "font-family": "sans-serif"
          })
        );
      }
    }
  }
  function placeRoomLabel(name, cells) {
    let sx = 0, sy = 0;
    const rows = /* @__PURE__ */ new Map();
    for (const c of cells.values()) {
      sx += MARGIN + (c.col - 0.5) * CELL;
      sy += MARGIN + (c.row - 0.5) * CELL;
      const list = rows.get(c.row) ?? [];
      list.push(c.col);
      rows.set(c.row, list);
    }
    const cx = sx / cells.size;
    const cy = sy / cells.size;
    const w = name.length * 10 * 0.58;
    let best = { x: cx, y: cy - 8 };
    let bestScore = Infinity;
    const candidates = [];
    for (const [row, cols] of rows) {
      cols.sort((a, b) => a - b);
      const rowY = MARGIN + (row - 0.5) * CELL;
      let start = cols[0];
      let prev = cols[0];
      const flush = (end) => void candidates.push({ x: MARGIN + ((start + end) / 2 - 0.5) * CELL, rowY, runW: (end - start + 1) * CELL });
      for (const col of cols.slice(1)) {
        if (col !== prev + 1) {
          flush(prev);
          start = col;
        }
        prev = col;
      }
      flush(prev);
    }
    for (const { x, rowY, runW } of candidates) {
      const box = { x: x - w / 2, y: rowY - 5, w, h: 10 };
      let overlap = 0;
      for (const o of labelObstructions) {
        const ox = Math.max(0, Math.min(box.x + box.w, o.x + o.w) - Math.max(box.x, o.x));
        const oy = Math.max(0, Math.min(box.y + box.h, o.y + o.h) - Math.max(box.y, o.y));
        overlap += ox * oy;
      }
      const score = overlap + Math.abs(rowY - cy) * 0.5 + Math.abs(x - cx) * 0.1 + Math.max(0, w - runW) * 2;
      if (score < bestScore) {
        bestScore = score;
        best = { x, y: rowY + 3.5 };
      }
    }
    return best;
  }
  function renderUnparentedOpening(e, titleEl, anchor) {
    const rock = impassableCells(model);
    const barrierEdges = /* @__PURE__ */ new Set();
    for (const other of model.entities) {
      if (other.archetype === "structure") {
        const cells = structureCells(other);
        for (const pe of perimeterEdges(cells)) {
          const address = { kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row };
          barrierEdges.add(segKey(edgeSegment(address, pe.dir)));
        }
      } else if (other.archetype === "barrier") {
        for (const p of other.placements) {
          if (p.kind === "edge") barrierEdges.add(segKey(edgeSegment(p.at, p.dir)));
        }
      }
    }
    const chain = model.chainOf(e.typeWord);
    const windowLike = chain.includes("window") || chain.includes("arrow-slit");
    const stroke = model.theme.prop(chain, "stroke") ?? (windowLike ? "#6fa8c9" : "#a8763e");
    const width = Number(model.theme.prop(chain, "width") ?? (windowLike ? 2.5 : 5)) || (windowLike ? 2.5 : 5);
    const parts = [titleEl];
    for (const p of e.placements) {
      if (p.kind !== "edge") continue;
      const here = { col: colToNumber2(p.at.col), row: p.at.row };
      const steps = {
        n: { dc: 0, dr: -1 },
        s: { dc: 0, dr: 1 },
        e: { dc: 1, dr: 0 },
        w: { dc: -1, dr: 0 }
      };
      const n = steps[p.dir];
      if (!n) {
        diagnostics.push({
          severity: "error",
          line: e.line,
          message: `an opening takes a cell EDGE (n/e/s/w), not the corner ${p.at.col}${p.at.row}.${p.dir} (spec 02 \xA75)`
        });
        continue;
      }
      const onBarrier = barrierEdges.has(segKey(edgeSegment(p.at, p.dir)));
      const solidHere = rock.has(`${here.col}:${here.row}`);
      const solidThere = rock.has(`${here.col + n.dc}:${here.row + n.dr}`);
      if (!onBarrier && solidHere === solidThere) {
        diagnostics.push({
          severity: "error",
          line: e.line,
          message: solidHere ? `opening '${e.typeWord ?? ""}' at ${p.at.col}${p.at.row}.${p.dir} has solid ground on both sides \u2014 it passes through nothing (spec 06 \xA73)` : `opening '${e.typeWord ?? ""}' at ${p.at.col}${p.at.row}.${p.dir} has no barrier to perforate \u2014 give it a parent structure, a freestanding wall, or a declared impassable surface (spec 06 \xA73)`
        });
        continue;
      }
      const s = edgeSegment(p.at, p.dir);
      const ruinedDoor = e.flags.includes("ruined");
      parts.push(el("line", {
        x1: s.a.x,
        y1: s.a.y,
        x2: s.b.x,
        y2: s.b.y,
        stroke,
        "stroke-width": width,
        "stroke-dasharray": ruinedDoor ? "4 4" : void 0,
        opacity: ruinedDoor ? 0.6 : void 0
      }));
      parts.push(...openingStateMarks(e, s, stroke, width, model.theme.surface("paper", "fill", PAPER)));
    }
    if (parts.length > 1) layers.openings.push(el("g", { id: anchor }, ...parts));
  }
  function courseOf(ref) {
    const key = ref.value;
    for (const other of model.entities) {
      const matches = ref.form === "id" ? other.ids.includes(key) : other.name === key;
      if (!matches) continue;
      for (const p of other.placements) {
        if (p.kind === "shape" && p.shape === "path") {
          const addresses = p.args.filter((a) => a.kind === "address");
          if (addresses.length > 1) return addresses.map(cellCenter);
        }
      }
    }
    return null;
  }
  function renderFreeText(e, into, titleEl, anchor) {
    const label = e.texts[0] ?? e.name;
    if (!label) return;
    const textFill = model.theme.prop(model.chainOf(e.typeWord), "fill") ?? model.theme.surface("ink", "fill", INK);
    const range = e.placements.find((p) => p.kind === "range");
    const address = e.placements.find((p) => p.kind === "address");
    let at = null;
    let span = 0;
    if (range) {
      const r = rangeRect(range);
      at = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      span = r.w;
    } else if (address) {
      at = cellCenter(address);
    }
    if (!at) {
      const along = e.placements.find((p) => p.kind === "relational" && p.form === "along");
      const course = along && along.kind === "relational" ? courseOf(along.ref) : null;
      if (course && course.length > 1) {
        const pid = `cdnote-${model.doc.docId}-${noteCourseCount++}`;
        const d = `M${fmt(course[0].x)} ${fmt(course[0].y)}` + course.slice(1).map((pt) => `L${fmt(pt.x)} ${fmt(pt.y)}`).join("");
        into.push(
          `<defs><path id="${pid}" d="${d}"/></defs><text font-size="9" fill="${textFill}" text-anchor="middle" font-family="sans-serif"><textPath href="#${pid}" startOffset="50%"><tspan dy="-4">${esc(label)}</tspan></textPath></text>`
        );
        return;
      }
      diagnostics.push({
        severity: "warning",
        line: e.line,
        message: `free text "${label}" has no cell, range, or resolvable course \u2014 this renderer draws nothing for it (spec 07 \xA72)`
      });
      return;
    }
    const size = 9;
    const spacing = e.flags.includes("sprawl") && span > 0 ? Math.max(0, (span - label.length * size * 0.58) / Math.max(1, label.length - 1)) : void 0;
    into.push(
      el(
        "g",
        { id: anchor },
        titleEl,
        text(label, {
          x: at.x,
          y: at.y,
          "font-size": size,
          "letter-spacing": spacing,
          fill: textFill,
          "text-anchor": "middle",
          "font-family": "sans-serif"
        })
      )
    );
  }
  function renderZone(e, into, labels, titleEl, anchor, elevation) {
    const range = e.placements.find((p) => p.kind === "range");
    if (!range) return;
    const r = rangeRect(range);
    const gmZone = e.gmOnly;
    const themed = model.theme.prop(model.chainOf(e.typeWord), "fill");
    const stroke = themed ?? (gmZone ? "#b5504a" : elevation ? "#6b5d4a" : "#4a9a6a");
    into.push(
      el(
        "g",
        { id: anchor, class: elevation ? "ledge" : void 0 },
        titleEl,
        el("rect", {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          fill: themed ?? (gmZone ? "#b5504a" : elevation ? "#efe6d2" : "#4a9a6a"),
          opacity: elevation ? 0.7 : 0.12
        }),
        el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: "none", stroke, "stroke-width": elevation ? 3.5 : 1.5, "stroke-dasharray": elevation ? void 0 : "6 4" })
      )
    );
    const label = e.name ?? e.ids[0] ?? e.typeWord;
    if (label && !e.flags.includes("nolabel") && labelsOn(model)) {
      labels.push(text(elevation ? `${label} (${elevation})` : label, { x: r.x + r.w / 2, y: r.y + 12, "font-size": 9, fill: stroke, "text-anchor": "middle", "font-family": "sans-serif" }));
    }
  }
  function renderBarrier(e, into, titleEl, anchor) {
    const chain = model.chainOf(e.typeWord);
    const isFence = chain.includes("fence");
    const ruined = e.flags.includes("ruined");
    const parts = [titleEl];
    if (!e.name && !titleEl && e.typeWord) parts.unshift(svgTitle(e.typeWord));
    const themedStroke = model.theme.prop(chain, "stroke");
    const themedDash = model.theme.prop(chain, "dash")?.replace(",", " ");
    const themedWidth = model.theme.prop(chain, "width");
    for (const p of e.placements) {
      if (p.kind === "edge") {
        const s = edgeSegment(p.at, p.dir);
        parts.push(
          el("line", {
            x1: s.a.x,
            y1: s.a.y,
            x2: s.b.x,
            y2: s.b.y,
            stroke: themedStroke ?? (isFence ? "#8a7a5c" : INK),
            "stroke-width": Number(themedWidth ?? (isFence ? 2 : 3)) || (isFence ? 2 : 3),
            "stroke-dasharray": ruined && !isFence ? "5 6" : themedDash ?? (isFence ? "3 3" : void 0),
            opacity: ruined ? 0.7 : 1,
            "stroke-linecap": "square"
          })
        );
      } else if (p.kind === "address") {
        const c = cellCenter(p);
        const glyph2 = model.theme.glyphFor(chain, c.x, c.y);
        if (glyph2) {
          parts.push(themedGlyphPath(glyph2, chain, c));
        } else {
          const fill = model.theme.prop(chain, "fill") ?? "#5a5244";
          parts.push(el("rect", { x: c.x - 6, y: c.y - 6, width: 12, height: 12, fill, stroke: INK, "stroke-width": 1 }));
        }
      }
    }
    into.push(el("g", { id: anchor }, ...parts));
    if (e.name && !e.flags.includes("nolabel") && labelsOn(model)) {
      const first = e.placements.find((p) => p.kind === "edge" || p.kind === "address");
      if (first) {
        const at = first.kind === "edge" ? edgeSegment(first.at, first.dir).a : cellCenter(first);
        const lbl = labelTextFor(model, e) ?? e.name;
        layers.labels.push(text(lbl, { x: at.x, y: at.y - 6, "font-size": 8, fill: INK, "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-family": "sans-serif" }));
      }
    }
  }
  function themedGlyphPath(d, chain, c) {
    const fill = model.theme.prop(chain, "fill");
    const stroke = model.theme.prop(chain, "stroke") ?? model.theme.surface("ink", "fill", INK);
    const width = Number(model.theme.prop(chain, "width") ?? 1.6) || 1.6;
    const opacity = model.theme.prop(chain, "opacity");
    return `<path d="${d}" transform="translate(${fmt(c.x)} ${fmt(c.y)}) scale(0.9)" fill="${fill ?? "none"}" stroke="${stroke}" stroke-width="${fmt(width)}"${opacity ? ` opacity="${opacity}"` : ""} vector-effect="non-scaling-stroke" stroke-linecap="round"/>`;
  }
  function fallbackGlyph(e, chain, c, scale, parts) {
    const has = (w) => chain.includes(w);
    if (has("campfire") || has("torch") || has("brazier") || has("lantern")) {
      parts.push(el("circle", { cx: c.x, cy: c.y + 1.5 * scale, r: 6 * scale, fill: "#d9822b", stroke: "#a8541e", "stroke-width": 1.5 }));
      parts.push(
        el("path", {
          d: `M${fmt(c.x - 3 * scale)} ${fmt(c.y - 3 * scale)} Q${fmt(c.x - 1 * scale)} ${fmt(c.y - 9 * scale)} ${fmt(c.x + 1 * scale)} ${fmt(c.y - 5 * scale)} Q${fmt(c.x + 2.5 * scale)} ${fmt(c.y - 8 * scale)} ${fmt(c.x + 3.5 * scale)} ${fmt(c.y - 3.5 * scale)}`,
          fill: "none",
          stroke: "#a8541e",
          "stroke-width": 1.5,
          "stroke-linecap": "round"
        })
      );
      return true;
    }
    if (has("wagon")) {
      const facing = pairOf(e.pairs, "facing");
      const rot = facing === "south" || facing === "north" ? 90 : 0;
      parts.push(
        el("rect", {
          x: c.x - CELL * 0.45 * scale,
          y: c.y - CELL * 0.28 * scale,
          width: CELL * 0.9 * scale,
          height: CELL * 0.56 * scale,
          fill: "#a8763e",
          stroke: INK,
          "stroke-width": 1.5,
          "stroke-dasharray": e.flags.includes("overturned") ? "4 3" : void 0,
          transform: rot ? `rotate(${rot} ${fmt(c.x)} ${fmt(c.y)})` : void 0
        })
      );
      return true;
    }
    if (has("stairs") || has("ramp")) {
      const facing = pairOf(e.pairs, "facing") ?? "n";
      const rot = { n: 0, e: 90, s: 180, w: 270 }[facing] ?? 0;
      const stair = [];
      for (const [i, w] of [4, 7, 10].entries()) {
        const y = c.y + (i - 1) * 6 * scale;
        stair.push(el("line", { x1: c.x - w * scale, y1: y, x2: c.x + w * scale, y2: y, stroke: INK, "stroke-width": 2.2 }));
      }
      stair.push(
        el("path", {
          d: `M${fmt(c.x - 3 * scale)} ${fmt(c.y - 9 * scale)} L${fmt(c.x)} ${fmt(c.y - 13 * scale)} L${fmt(c.x + 3 * scale)} ${fmt(c.y - 9 * scale)}`,
          fill: "none",
          stroke: INK,
          "stroke-width": 1.8,
          "stroke-linecap": "round",
          "stroke-linejoin": "round"
        })
      );
      parts.push(rot === 0 ? stair.join("") : el("g", { transform: `rotate(${rot} ${fmt(c.x)} ${fmt(c.y)})` }, ...stair));
      return true;
    }
    return false;
  }
  function renderToken(e, into, labels, titleEl, anchor) {
    const size = Number(pairOf(e.pairs, "size") ?? 1) || 1;
    const fill = model.theme.side(pairOf(e.pairs, "side"));
    const addresses = e.placements.filter((p) => p.kind === "address");
    addresses.forEach((a, idx) => {
      const base = cellCenter(a);
      const center = { x: base.x + (size - 1) * CELL / 2, y: base.y + (size - 1) * CELL / 2 };
      const radius = 0.38 * CELL * size;
      const label = addresses.length > 1 ? e.ids[idx] ?? `${e.typeWord}${idx + 1}` : labelTextFor(model, e) ?? e.ids[0] ?? e.typeWord ?? "?";
      into.push(
        el(
          "g",
          { id: idx === 0 ? anchor : void 0 },
          titleEl,
          el("circle", {
            cx: center.x,
            cy: center.y,
            r: radius,
            fill,
            opacity: 0.9,
            stroke: e.flags.includes("hidden") ? "#fff" : "#3d3629",
            "stroke-width": 1.5,
            "stroke-dasharray": e.flags.includes("hidden") ? "3 3" : void 0
          })
        )
      );
      if (!e.flags.includes("nolabel") && labelsOn(model)) {
        labels.push(text(label, { x: center.x, y: center.y + radius + 10, "font-size": 9, fill: INK, "text-anchor": "middle", "font-family": "sans-serif" }));
      }
    });
  }
  function renderFeature(e, into, labels, titleEl, anchor) {
    const addresses = e.placements.filter((p) => p.kind === "address");
    if (addresses.length > 1) {
      addresses.forEach((a, idx) => {
        const one = { ...e, placements: [a], name: idx === 0 ? e.name : null };
        renderFeature(one, into, labels, idx === 0 ? titleEl : "", idx === 0 ? anchor : void 0);
      });
      return;
    }
    const address = addresses[0];
    const range = e.placements.find((p) => p.kind === "range");
    if (!address && !range) {
      const shape = e.placements.find((p) => p.kind === "shape");
      if (shape) {
        diagnostics.push({
          severity: "error",
          line: e.line,
          message: `'${e.typeWord ?? "feature"}' is placed with '${shape.kind === "shape" ? shape.shape : "a shape"}', and a feature's footprint on a battlemap is CELLS \u2014 give it a cell (\`F6\`) or a range (\`D4..F6\`). Drawn shapes are terrain's, not a feature's (spec 06 \xA72)`
        });
      }
      return;
    }
    if (!address && range) {
      const r = rangeRect(range);
      const chainR = model.chainOf(e.typeWord);
      const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      const footprintParts = [titleEl];
      if (!e.name && !titleEl && e.typeWord) footprintParts.unshift(svgTitle(e.typeWord));
      const light2 = pairOf(e.pairs, "light") ?? model.facetOf(e.typeWord, "light");
      if (light2) {
        const radius = measureToCells(light2, model) * CELL;
        noteHole("light", emitterHole(center, radius));
        footprintParts.push(
          sightBlockers.length > 0 ? el("polygon", { points: pointsAttr(visibilityPolygon(center, radius, sightBlockers)), fill: model.theme.surface("light", "fill", "#ffd98a"), opacity: 0.22 }) : el("circle", { cx: center.x, cy: center.y, r: radius, fill: model.theme.surface("light", "fill", "#ffd98a"), opacity: 0.22 })
        );
      }
      const themed0 = model.theme.glyphFor(chainR, center.x, center.y);
      const glyphless = !themed0 && !["campfire", "torch", "brazier", "lantern", "wagon", "stairs", "ramp"].some((w) => chainR.includes(w));
      const slabFill = glyphless ? model.theme.prop(chainR, "fill") ?? wordTint(chainR[chainR.length - 1] ?? "") : "#8f8474";
      footprintParts.push(
        el("rect", { x: r.x + 3, y: r.y + 3, width: r.w - 6, height: r.h - 6, fill: slabFill, stroke: INK, "stroke-width": 1.2, rx: 2 })
      );
      const themed = themed0;
      if (themed) {
        const ink = model.theme.surface("ink", "fill", INK);
        const scale = Math.min(r.w, r.h) / 24 * 0.7;
        footprintParts.push(
          `<path d="${themed}" transform="translate(${fmt(center.x)} ${fmt(center.y)}) scale(${fmt(scale)})" fill="none" stroke="${ink}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`
        );
      } else {
        fallbackGlyph(e, chainR, center, Math.max(1, Math.min(r.w, r.h) / CELL) * 0.8, footprintParts);
      }
      if (e.flags.includes("difficult")) {
        footprintParts.push(el("rect", { x: r.x + 3, y: r.y + 3, width: r.w - 6, height: r.h - 6, fill: "url(#hatch)", rx: 2 }));
      }
      into.push(el("g", { id: anchor }, ...footprintParts));
      if (e.name && !e.flags.includes("nolabel") && labelsOn(model)) {
        const lbl = labelTextFor(model, e) ?? e.name;
        labels.push(text(lbl, { x: center.x, y: r.y + r.h + 10, "font-size": 8, fill: INK, "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-family": "sans-serif" }));
      }
      return;
    }
    const c = cellCenter(address);
    const parts = [titleEl];
    const to = pairOf(e.pairs, "to");
    if (to !== void 0 && levelCtx) {
      renderConnector(e, model.chainOf(e.typeWord), c, to, parts, into, anchor);
      return;
    }
    const light = pairOf(e.pairs, "light") ?? model.facetOf(e.typeWord, "light");
    if (light) {
      const radius = measureToCells(light, model) * CELL;
      noteHole("light", emitterHole(c, radius));
      if (sightBlockers.length > 0) {
        const poly = visibilityPolygon(c, radius, sightBlockers);
        parts.push(el("polygon", { points: pointsAttr(poly), fill: model.theme.surface("light", "fill", "#ffd98a"), opacity: 0.22 }));
      } else {
        parts.push(el("circle", { cx: c.x, cy: c.y, r: radius, fill: model.theme.surface("light", "fill", "#ffd98a"), opacity: 0.22 }));
      }
    }
    const chain = model.chainOf(e.typeWord);
    const themedGlyph = model.theme.glyphFor(chain, c.x, c.y);
    let drewFallback = false;
    if (themedGlyph) {
      parts.push(themedGlyphPath(themedGlyph, chain, c));
    } else if (fallbackGlyph(e, chain, c, 1, parts)) {
      drewFallback = true;
    } else {
      const fill = model.theme.prop(chain, "fill") ?? wordTint(chain[chain.length - 1] ?? "");
      parts.push(el("rect", { x: c.x - 6, y: c.y - 6, width: 12, height: 12, fill, stroke: INK, "stroke-width": 1 }));
    }
    if (!e.name && !hasBattlemapGlyph(chain) && !themedGlyph && !drewFallback && !titleEl && e.typeWord) {
      parts.unshift(svgTitle(e.typeWord));
    }
    if (e.flags.includes("difficult")) {
      const o = cellOrigin(address);
      parts.push(el("rect", { x: o.x, y: o.y, width: CELL, height: CELL, fill: "url(#hatch)" }));
    }
    into.push(el("g", { id: anchor }, ...parts));
    if (e.name && !e.flags.includes("nolabel") && labelsOn(model)) {
      const lbl = labelTextFor(model, e) ?? e.name;
      labels.push(text(lbl, { x: c.x, y: c.y + 20, "font-size": 8, fill: INK, "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-family": "sans-serif" }));
    }
  }
}
function hasOnlyRange(e) {
  return e.placements.length > 0 && e.placements.every((p) => p.kind === "range");
}
function openingStateMarks(e, s, stroke, width, paper) {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
  const out = [];
  if (e.flags.includes("locked")) {
    out.push(el("circle", { cx: mid.x, cy: mid.y, r: Math.max(1.6, width * 0.32), fill: paper }));
  }
  if (e.flags.includes("barred")) {
    const off = width * 0.9;
    const reach = len * 0.42;
    out.push(el("line", {
      x1: mid.x - ux * reach + nx * off,
      y1: mid.y - uy * reach + ny * off,
      x2: mid.x + ux * reach + nx * off,
      y2: mid.y + uy * reach + ny * off,
      stroke,
      "stroke-width": Math.max(1.2, width * 0.4),
      "stroke-linecap": "round"
    }));
  }
  if (e.flags.includes("stuck")) {
    const h = width * 0.85;
    const w = len * 0.16;
    out.push(el("polygon", {
      points: [
        `${fmt(mid.x - ux * w)},${fmt(mid.y - uy * w)}`,
        `${fmt(mid.x + ux * w)},${fmt(mid.y + uy * w)}`,
        `${fmt(mid.x + nx * h)},${fmt(mid.y + ny * h)}`
      ].join(" "),
      fill: stroke
    }));
  }
  return out;
}
function extendToCellEdge(pts) {
  if (pts.length < 2) return pts;
  const out = pts.map((p) => ({ ...p }));
  const reach = (end, inward) => {
    const dx = end.x - inward.x;
    const dy = end.y - inward.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const ux = dx / len;
    const uy = dy / len;
    const half = CELL / 2;
    const t = Math.min(
      Math.abs(ux) > 1e-9 ? half / Math.abs(ux) : Infinity,
      Math.abs(uy) > 1e-9 ? half / Math.abs(uy) : Infinity
    );
    end.x += ux * t;
    end.y += uy * t;
  };
  reach(out[0], out[1]);
  reach(out[out.length - 1], out[out.length - 2]);
  return out;
}

// packages/render-svg/src/labels.ts
var TEXT_WEIGHT = 3;
var LEGIBILITY_FRACTION = 1 / 130;
var LEGIBILITY_MIN = 4;
var HIERARCHY_RATIO = 0.7;
var NOMINAL_WIDTH = 820;
var shrinkFloor = (fontSize, canvasWidth = NOMINAL_WIDTH) => {
  const legibility = Math.max(LEGIBILITY_MIN, canvasWidth * LEGIBILITY_FRACTION);
  return Math.min(fontSize, Math.round(Math.max(legibility, fontSize * HIERARCHY_RATIO)));
};
var LEADER_REACH = 100;
var LEADER_MIN = 14;
var LabelPlacer = class {
  boxes = [];
  bounds;
  /** With bounds, candidates that would leave the viewport are rejected. */
  constructor(bounds) {
    this.bounds = bounds ?? null;
  }
  inBounds(box) {
    if (!this.bounds) return true;
    return box.x >= 2 && box.y >= 2 && box.x + box.w <= this.bounds.w - 2 && box.y + box.h <= this.bounds.h - 2;
  }
  /** Reserve a non-label obstacle so labels avoid it. Weight 1 = thin geometry; pass 3 for text-like content. */
  block(x, y, w, h, weight = 1) {
    this.boxes.push({ x, y, w, h, weight });
  }
  /** A removable obstacle: reserve now, release later (name homes — a spot held for a label that hasn't placed yet). */
  tempBlock(x, y, w, h, weight = 1) {
    const box = { x, y, w, h, weight };
    this.boxes.push(box);
    return box;
  }
  release(handle) {
    const i = this.boxes.indexOf(handle);
    if (i >= 0) this.boxes.splice(i, 1);
  }
  /**
   * The smallest size this label may shrink to: the larger of what the reader
   * can still make out and what its rank requires (see the constants above).
   * Never above the base size, so a small label is not floored out of shrinking
   * altogether on a large canvas.
   */
  floorFor(fontSize) {
    return shrinkFloor(fontSize, this.bounds?.w ?? NOMINAL_WIDTH);
  }
  boxFor(x, y, textStr, fontSize, anchor, widthPx) {
    const w = widthPx ?? textStr.length * fontSize * 0.58;
    const h = fontSize * 1.1;
    const bx = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
    return { x: bx, y: y - h, w, h, weight: TEXT_WEIGHT };
  }
  tryClaim(x, y, textStr, fontSize, anchor, widthPx) {
    const box = this.boxFor(x, y, textStr, fontSize, anchor, widthPx);
    if (!this.inBounds(box)) return false;
    if (this.boxes.some((b) => intersects(b, box))) return false;
    this.boxes.push(box);
    return true;
  }
  claim(x, y, textStr, fontSize, anchor, widthPx) {
    this.boxes.push(this.boxFor(x, y, textStr, fontSize, anchor, widthPx));
  }
  /**
   * Claim a candidate box if free; returns whether it was claimed. For label
   * forms the placer can't position itself (e.g. textPath along a curve) —
   * the caller proposes, the placer arbitrates and remembers.
   */
  claimIfFree(x, y, textStr, fontSize, anchor, widthPx) {
    return this.tryClaim(x, y, textStr, fontSize, anchor, widthPx);
  }
  /** Claim an explicit centered box if free (curve labels size their own). */
  claimBoxIfFree(cx, top, wpx, h) {
    const box = { x: cx - wpx / 2, y: top, w: wpx, h };
    if (!this.inBounds(box)) return false;
    if (this.boxes.some((b) => intersects(b, box))) return false;
    this.boxes.push(box);
    return true;
  }
  /**
   * Overlap cost of a centered box WITHOUT claiming it — candidate sweeps
   * probe every option first and claim only the winner, so a rejected
   * attempt never leaves phantom boxes behind to push later labels around.
   */
  boxCost(cx, top, wpx, h) {
    return this.overlapArea({ x: cx - wpx / 2, y: top, w: wpx, h });
  }
  /** Unconditionally claim a centered box (the winner of a probed sweep). Curve-label text. */
  claimBox(cx, top, wpx, h) {
    this.boxes.push({ x: cx - wpx / 2, y: top, w: wpx, h, weight: TEXT_WEIGHT });
  }
  /** Occupied area within a rect (bounds-free probe — density checks). */
  occupancy(x, y, w, h) {
    let area = 0;
    for (const b of this.boxes) {
      const ox = Math.max(0, Math.min(x + w, b.x + b.w) - Math.max(x, b.x));
      const oy = Math.max(0, Math.min(y + h, b.y + b.h) - Math.max(y, b.y));
      area += ox * oy;
    }
    return area;
  }
  /**
   * Line-feature labels: candidates are points ALONG the feature (mid-course
   * first, sliding outward); the first free one wins. Sliding along the line
   * keeps the label attached to what it names — a vertical nudge off a road
   * reads as labeling the neighbor. Falls back to vertical nudges at the
   * first candidate only when the whole course is crowded.
   */
  placeAlong(candidates, textStr, fontSize, anchor) {
    for (const c of candidates) {
      if (this.tryClaim(c.x, c.y, textStr, fontSize, anchor)) return c;
    }
    const first = candidates[0];
    return { x: first.x, y: this.place(first.x, first.y, textStr, fontSize, anchor) };
  }
  overlapArea(box) {
    let area = 0;
    for (const b of this.boxes) {
      const ox = Math.max(0, Math.min(box.x + box.w, b.x + b.w) - Math.max(box.x, b.x));
      const oy = Math.max(0, Math.min(box.y + box.h, b.y + b.h) - Math.max(box.y, b.y));
      area += ox * oy * (b.weight ?? 1);
    }
    if (!this.inBounds(box)) area += 1e6;
    return area;
  }
  /** Returns the chosen y (x is never moved — horizontal shifts read as errors on maps). */
  place(x, y, textStr, fontSize, anchor, widthPx) {
    const h = fontSize * 1.1;
    const step = h + 2;
    const offsets = [0, step, -step, 2 * step, -2 * step, 3 * step];
    for (const dy of offsets) {
      if (this.tryClaim(x, y + dy, textStr, fontSize, anchor, widthPx)) return y + dy;
    }
    let best = 0;
    let bestScore = Infinity;
    offsets.forEach((dy, i) => {
      const score = this.overlapArea(this.boxFor(x, y + dy, textStr, fontSize, anchor, widthPx)) + i * fontSize * 2;
      if (score < bestScore) {
        bestScore = score;
        best = dy;
      }
    });
    this.claim(x, y + best, textStr, fontSize, anchor, widthPx);
    return y + best;
  }
  /**
   * Dense-map conduct (spec 07 §5): shrink before moving far, omit before
   * overwriting. Tries the normal nudge ladder at the base size, then
   * retries the whole ladder at smaller sizes (floor 8px); if even the
   * least-bad shrunk spot would cover most of the label with other text,
   * returns null — the caller drops the label rather than scrawl it.
   */
  placeOrDrop(x, y, textStr, fontSize, anchor, dxs = [0], widthPx, allow) {
    const floor = this.floorFor(fontSize);
    const offsetsAt = (size) => {
      const step = size * 1.1 + 2;
      const out = [];
      for (const dy of [0, step, -step, 2 * step, -2 * step]) for (const dx of dxs) out.push({ dx, dy });
      return out.filter((o) => !allow || allow(x + o.dx, y + o.dy));
    };
    for (let size = fontSize; size >= floor; size--) {
      for (const o of offsetsAt(size)) {
        if (this.tryClaim(x + o.dx, y + o.dy, textStr, size, anchor, widthPx)) return { x: x + o.dx, y: y + o.dy, size };
      }
    }
    const leastBad = (size) => {
      let best = { dx: 0, dy: 0 };
      let bestScore = Infinity;
      offsetsAt(size).forEach((o, i) => {
        const score = this.overlapArea(this.boxFor(x + o.dx, y + o.dy, textStr, size, anchor, widthPx)) + i * size;
        if (score < bestScore) {
          bestScore = score;
          best = o;
        }
      });
      const box = this.boxFor(x + best.dx, y + best.dy, textStr, size, anchor, widthPx);
      return { o: best, overlap: this.overlapArea(box), area: box.w * box.h };
    };
    for (let size = fontSize; size >= floor; size--) {
      const b2 = leastBad(size);
      if (b2.overlap <= b2.area * 0.12) {
        this.claim(x + b2.o.dx, y + b2.o.dy, textStr, size, anchor, widthPx);
        return { x: x + b2.o.dx, y: y + b2.o.dy, size };
      }
    }
    const b = leastBad(floor);
    if (b.overlap > b.area * 0.5) return null;
    this.claim(x + b.o.dx, y + b.o.dy, textStr, floor, anchor, widthPx);
    return { x: x + b.o.dx, y: y + b.o.dy, size: floor };
  }
};
var SideLabelPlacer = class extends LabelPlacer {
  /**
   * Point-marker labels: try right of the marker, then left, then vertical
   * nudges on both sides — clusters spread sideways instead of stacking far
   * from their markers. Fixed candidate order keeps it deterministic.
   */
  placeBeside(rightX, leftX, y, textStr, fontSize) {
    const step = fontSize * 1.1 + 2;
    const midX = (rightX + leftX) / 2;
    const candidates = [
      { x: rightX, y, anchor: "start" },
      { x: leftX, y, anchor: "end" },
      { x: midX, y: y - step, anchor: "middle" },
      { x: midX, y: y + step + 4, anchor: "middle" },
      { x: rightX, y: y + step, anchor: "start" },
      { x: leftX, y: y + step, anchor: "end" },
      { x: rightX, y: y - step, anchor: "start" },
      { x: leftX, y: y - step, anchor: "end" }
    ];
    for (const c of candidates) {
      if (this.tryClaim(c.x, c.y, textStr, fontSize, c.anchor)) return c;
    }
    let best = candidates[0];
    let bestScore = Infinity;
    candidates.forEach((c, i) => {
      const score = this.overlapArea(this.boxFor(c.x, c.y, textStr, fontSize, c.anchor)) + i * fontSize * 2;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    });
    this.claim(best.x, best.y, textStr, fontSize, best.anchor);
    return best;
  }
  /**
   * Last rung before omission (spec 07 §5, #133): put the name in open space
   * near the marker and let a leader line carry the association.
   *
   * Only reached when every adjacent slot has failed at every size, so this
   * competes with dropping the name, not with placing it well. Candidates ring
   * the marker at growing radius, ordered so the nearest and the most
   * conventional directions win — placement stays a pure function of geometry
   * and declaration order (spec 02 §8.2).
   */
  placeWithLeader(cx, cy, textStr, fontSize) {
    const reach = LEADER_REACH;
    const dirs = [
      { dx: 1, dy: -1, anchor: "start" },
      { dx: -1, dy: -1, anchor: "end" },
      { dx: 1, dy: 1, anchor: "start" },
      { dx: -1, dy: 1, anchor: "end" },
      { dx: 1, dy: 0, anchor: "start" },
      { dx: -1, dy: 0, anchor: "end" },
      { dx: 0, dy: -1, anchor: "middle" },
      { dx: 0, dy: 1, anchor: "middle" }
    ];
    for (let r = LEADER_MIN; r <= reach; r += 6) {
      for (const size of [fontSize, this.floorFor(fontSize)]) {
        for (const d of dirs) {
          const norm = Math.hypot(d.dx, d.dy) || 1;
          const x = cx + d.dx / norm * r;
          const y = cy + d.dy / norm * r;
          if (!this.tryClaim(x, y, textStr, size, d.anchor)) continue;
          const box = this.boxFor(x, y, textStr, size, d.anchor);
          const fromX = d.dx > 0 ? box.x : d.dx < 0 ? box.x + box.w : box.x + box.w / 2;
          return { x, y, anchor: d.anchor, size, from: { x: fromX, y: box.y + box.h / 2 } };
        }
      }
    }
    return null;
  }
  /**
   * Dense-map conduct for point labels (spec 07 §5): shrink before moving,
   * omit before overwriting. Sweeps the beside-candidates at the base size,
   * then smaller (floor 8px); when even the least-bad shrunk candidate would
   * mostly cover other text, returns null and the marker goes unnamed —
   * an unlabeled point reads better than two names on top of each other.
   */
  placeBesideOrDrop(rightX, leftX, y, textStr, fontSize) {
    const floor = this.floorFor(fontSize);
    const candidatesAt = (size) => {
      const step = size * 1.1 + 2;
      const midX = (rightX + leftX) / 2;
      return [
        { x: rightX, y, anchor: "start" },
        { x: leftX, y, anchor: "end" },
        { x: midX, y: y - step, anchor: "middle" },
        { x: midX, y: y + step + 4, anchor: "middle" },
        { x: rightX, y: y + step, anchor: "start" },
        { x: leftX, y: y + step, anchor: "end" },
        { x: rightX, y: y - step, anchor: "start" },
        { x: leftX, y: y - step, anchor: "end" }
      ];
    };
    for (let size = fontSize; size >= floor; size--) {
      for (const c of candidatesAt(size)) {
        if (this.tryClaim(c.x, c.y, textStr, size, c.anchor)) return { ...c, size };
      }
    }
    const leastBad = (size) => {
      const finalists = candidatesAt(size);
      let best = finalists[0];
      let bestScore = Infinity;
      finalists.forEach((c, i) => {
        const score = this.overlapArea(this.boxFor(c.x, c.y, textStr, size, c.anchor)) + i * size * 2;
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      });
      const box = this.boxFor(best.x, best.y, textStr, size, best.anchor);
      return { c: best, overlap: this.overlapArea(box), area: box.w * box.h };
    };
    for (let size = fontSize; size >= floor; size--) {
      const b2 = leastBad(size);
      if (b2.overlap <= b2.area * 0.12) {
        this.claim(b2.c.x, b2.c.y, textStr, size, b2.c.anchor);
        return { ...b2.c, size };
      }
    }
    const b = leastBad(floor);
    if (b.overlap > b.area * 0.5) return null;
    this.claim(b.c.x, b.c.y, textStr, floor, b.c.anchor);
    return { ...b.c, size: floor };
  }
};
var intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// packages/render-svg/src/hexcrawl.ts
var R = 24;
var MARGIN2 = 30;
var hexW = Math.sqrt(3) * R;
function hexFrame(model) {
  const cols = model.doc.grid?.cols ?? 8;
  const rows = model.doc.grid?.rows ?? 8;
  return { cols, rows, w: MARGIN2 * 2 + cols * hexW + hexW / 2, h: MARGIN2 * 2 + (rows - 1) * 1.5 * R + 2 * R };
}
var keyOf = (col, row) => `${col}:${row}`;
function shifted(row, parity) {
  const idx = parity.startsWith("odd") ? (row - 1) % 2 === 1 : (row - 1) % 2 === 0;
  return idx;
}
function renderHexcrawl(model, body) {
  const grid = model.doc.grid;
  const parity = grid?.parity ?? "odd-row";
  const cols = grid?.cols ?? 8;
  const rows = grid?.rows ?? 8;
  const center = (col, row) => ({
    x: MARGIN2 + (col - 1) * hexW + hexW / 2 + (shifted(row, parity) ? hexW / 2 : 0),
    y: MARGIN2 + (row - 1) * 1.5 * R + R
  });
  const corners = (c) => {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const angle = (60 * k - 30) * Math.PI / 180;
      pts.push({ x: c.x + R * Math.cos(angle), y: c.y + R * Math.sin(angle) });
    }
    return pts;
  };
  const cells = /* @__PURE__ */ new Map();
  const expand = (a) => {
    if (a.kind === "address") return [{ col: colToNumber2(a.col), row: a.row }];
    const c1 = colToNumber2(a.from.col);
    const c2 = colToNumber2(a.to.col);
    const out = [];
    for (let col = Math.min(c1, c2); col <= Math.max(c1, c2); col++) {
      for (let row = Math.min(a.from.row, a.to.row); row <= Math.max(a.from.row, a.to.row); row++) {
        out.push({ col, row });
      }
    }
    return out;
  };
  for (const line of model.hexLines) {
    for (const addr of line.addresses) {
      for (const { col, row } of expand(addr)) {
        cells.set(keyOf(col, row), {
          terrain: line.terrain,
          contents: line.contents,
          name: line.name,
          flags: line.flags,
          gm: pairOf(line.pairs, "gm")
        });
      }
    }
  }
  for (const e of model.entities) {
    if (e.section !== "hexes" || !e.typeWord) continue;
    for (const p of e.placements) {
      if (p.kind === "address" || p.kind === "range") {
        for (const { col, row } of expand(p)) {
          cells.set(keyOf(col, row), { terrain: e.typeWord, contents: [], name: e.name, flags: e.flags, gm: pairOf(e.pairs, "gm") });
        }
      }
    }
  }
  const hexLayer = [];
  const contentLayer = [];
  const labelLayer = [];
  const numbersOn = model.header.get("numbers") === "on";
  const gmMode = model.mode === "gm";
  const bounds = hexFrame(model);
  const placer = new LabelPlacer({ w: bounds.w, h: bounds.h });
  if (model.doc.title) placer.block(0, 0, model.doc.title.length * 10 + 30, 34);
  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      const c = center(col, row);
      const poly = pointsAttr(corners(c));
      const cell = cells.get(keyOf(col, row));
      const foggedForPlayer = !gmMode && (!cell || cell.flags.includes("unexplored"));
      const fogged = !cell || foggedForPlayer;
      const seen = !gmMode && !!cell && cell.flags.includes("seen");
      const fill = fogged ? model.theme.surface("fog", "fill", FOG) : model.theme.terrainFill(model.chainOf(cell.terrain));
      const parts = [];
      if (gmMode && cell?.gm) parts.push(svgTitle(cell.gm));
      parts.push(el("polygon", { points: poly, fill, stroke: model.theme.surface("grid", "stroke", GRID_LINE), "stroke-width": 1 }));
      if (!fogged && cell) {
        if (seen) {
          contentLayer.push(text("?", { x: c.x, y: c.y + 4, "font-size": 11, fill: "#8a8272", "text-anchor": "middle", "font-family": "sans-serif" }));
        } else {
          cell.contents.forEach((word, idx) => {
            const at = { x: c.x, y: c.y - 3 + idx * 9 };
            placer.block(at.x - 5, at.y - 5, 10, 10);
            contentLayer.push(glyph(word, at));
          });
          if (cell.name && labelsOn(model)) {
            const lbl = labelTextFor(model, cell) ?? cell.name;
            const anchorId = `cd-${model.doc.docId}-${slugify(cell.name)}`;
            const y = placer.place(c.x, c.y + R * 0.62, lbl, 7.5, "middle");
            labelLayer.push(
              el(
                "g",
                { id: anchorId },
                text(lbl, { x: c.x, y, "font-size": 7.5, fill: INK, "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-family": "sans-serif" })
              )
            );
          }
          if (gmMode && cell.gm) {
            contentLayer.push(el("circle", { cx: c.x + R * 0.55, cy: c.y - R * 0.55, r: 3, fill: "#b5504a" }));
          }
        }
      }
      if (numbersOn && !fogged) {
        labelLayer.push(text(`${colLetters2(col)}${row}`, { x: c.x - hexW * 0.26, y: c.y - R * 0.45, "font-size": 6, fill: "#8a8272", opacity: 0.75, "text-anchor": "middle", "font-family": "sans-serif" }));
      }
      hexLayer.push(el("g", {}, ...parts));
    }
  }
  const routeLayer = [];
  const regionLayer = [];
  for (const e of model.entities) {
    if (e.section === "routes") {
      const addresses = e.placements.filter((p) => p.kind === "address");
      const pts = addresses.map((a) => center(colToNumber2(a.col), a.row));
      if (pts.length < 2) continue;
      const chain = model.chainOf(e.typeWord);
      const isWaterHex = (a) => {
        const cell = cells.get(keyOf(colToNumber2(a.col), a.row));
        const terrainChain = cell ? model.chainOf(cell.terrain) : [];
        return terrainChain.some((word) => word === "sea" || word === "lake" || word === "water");
      };
      if (isWaterHex(addresses[0])) {
        pts[0] = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      }
      if (isWaterHex(addresses[addresses.length - 1])) {
        const n = pts.length;
        pts[n - 1] = { x: (pts[n - 1].x + pts[n - 2].x) / 2, y: (pts[n - 1].y + pts[n - 2].y) / 2 };
      }
      const stroke = model.theme.pathStroke(chain);
      const title = gmTitleFor(model, e);
      routeLayer.push(
        el(
          "g",
          { id: e.name ? `cd-${model.doc.docId}-${slugify(e.name)}` : void 0 },
          title ? svgTitle(title) : "",
          el("polyline", { points: pointsAttr(pts), fill: "none", stroke: stroke.stroke, "stroke-width": chain.includes("river") ? 4 : 3, "stroke-dasharray": stroke.dash ?? (chain.includes("road") ? "8 4" : void 0), "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.85 })
        )
      );
      if (e.name && labelsOn(model)) {
        const candidates = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74].map((t) => {
          const p = arcPoint(pts, t);
          return { x: p.x, y: p.y - R * 0.55 };
        });
        const lbl = labelTextFor(model, e) ?? e.name;
        const at = placer.placeAlong(candidates, lbl, 8, "middle");
        labelLayer.push(text(lbl, { x: at.x, y: at.y, "font-size": 8, fill: INK, opacity: 0.8, "font-style": "italic", "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-family": "sans-serif" }));
      }
      continue;
    }
    if (e.section === "regions") {
      const set = /* @__PURE__ */ new Set();
      for (const p of e.placements) {
        if (p.kind === "address" || p.kind === "range") for (const { col, row } of expand(p)) set.add(keyOf(col, row));
      }
      const edges = [];
      for (const key of set) {
        const [col, row] = key.split(":").map(Number);
        const c = center(col, row);
        const cs = corners(c);
        const neighborDirs = neighborDeltas(shifted(row, parity));
        const faceOrder = ["e", "se", "sw", "w", "nw", "ne"];
        faceOrder.forEach((face, k) => {
          const d = neighborDirs[face];
          if (!set.has(keyOf(col + d.x, row + d.y))) {
            const a = cs[k];
            const b = cs[(k + 1) % 6];
            edges.push(el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#7a5aa0", "stroke-width": 2.5, opacity: 0.75 }));
          }
        });
      }
      regionLayer.push(el("g", { id: e.name ? `cd-${model.doc.docId}-${slugify(e.name)}` : void 0 }, ...edges));
      if (e.name && set.size > 0 && labelsOn(model)) {
        let sx = 0;
        let minY = Infinity;
        let count = 0;
        for (const key of set) {
          const [col, row] = key.split(":").map(Number);
          const c = center(col, row);
          sx += c.x;
          count++;
          if (c.y < minY) minY = c.y;
        }
        const keyedLbl = labelTextFor(model, e);
        const labelText = model.labelsMode === "keyed" && keyedLbl !== null ? keyedLbl : e.name.toUpperCase();
        const width = labelText.length * (11 * 0.58 + 3);
        const y = placer.place(sx / count, minY - R * 1.35, labelText, 11, "middle", width);
        labelLayer.push(
          text(labelText, { x: sx / count, y, "font-size": 11, "letter-spacing": model.labelsMode === "keyed" ? void 0 : 3, fill: "#7a5aa0", opacity: 0.85, "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-family": "sans-serif" })
        );
      }
    }
  }
  body.push(...hexLayer, ...routeLayer, ...regionLayer, ...contentLayer, ...labelLayer);
}
function arcPoint(pts, t) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let want = total * t;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (want <= d && d > 0) {
      const f = want / d;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f };
    }
    want -= d;
  }
  return pts[pts.length - 1];
}
function glyph(word, at) {
  const tier = tierOf(word);
  switch (word) {
    case "dungeon":
      return el("rect", { x: at.x - 4, y: at.y - 4, width: 8, height: 8, fill: INK });
    case "ruin":
      return el("rect", { x: at.x - 4, y: at.y - 4, width: 8, height: 8, fill: "none", stroke: INK, "stroke-width": 1.2, "stroke-dasharray": "2 2" });
    case "keep":
    case "castle":
    case "tower":
      return el("polygon", { points: `${fmt(at.x - 4)},${fmt(at.y + 4)} ${fmt(at.x + 4)},${fmt(at.y + 4)} ${fmt(at.x)},${fmt(at.y - 5)}`, fill: INK });
    case "lair":
      return el("polygon", { points: `${fmt(at.x - 4)},${fmt(at.y + 4)} ${fmt(at.x + 4)},${fmt(at.y + 4)} ${fmt(at.x)},${fmt(at.y - 5)}`, fill: "none", stroke: INK, "stroke-width": 1.2 });
    default:
      return el("circle", { cx: at.x, cy: at.y, r: tier.r, fill: INK, stroke: "#fff", "stroke-width": 0.8 });
  }
}
function neighborDeltas(isShifted) {
  return isShifted ? { e: { x: 1, y: 0 }, w: { x: -1, y: 0 }, ne: { x: 1, y: -1 }, nw: { x: 0, y: -1 }, se: { x: 1, y: 1 }, sw: { x: 0, y: 1 } } : { e: { x: 1, y: 0 }, w: { x: -1, y: 0 }, ne: { x: 0, y: -1 }, nw: { x: -1, y: -1 }, se: { x: 0, y: 1 }, sw: { x: -1, y: 1 } };
}
function colLetters2(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// packages/render-svg/src/legend.ts
function kindFor(model, e) {
  if (!e.typeWord || e.gmOnly) return null;
  const chain = model.chainOf(e.typeWord);
  if (chain.includes("note") || chain.includes("start")) return null;
  switch (e.archetype) {
    case "terrain":
      return "fill";
    case "path":
      return "stroke";
    case "barrier":
      return "barrier";
    case "feature":
      return hasTierGlyph(chain) ? "tier" : "glyph";
    default:
      return null;
  }
}
function buildLegend(model, width) {
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (word, kind) => {
    if (!word || !kind || seen.has(word)) return;
    seen.add(word);
    rows.push({ word, kind });
  };
  const vocabWanted = model.header.get("legend") === "on";
  if (vocabWanted) {
    for (const e of model.entities) add(e.typeWord, kindFor(model, e));
    for (const hex of model.hexLines) {
      add(hex.terrain, "fill");
      for (const word of hex.contents) add(word, hasTierGlyph(model.chainOf(word)) ? "tier" : "glyph");
    }
  }
  const keyRows = [];
  if (model.labelsMode === "keyed") {
    for (const [node, n] of model.keys) keyRows.push({ n, name: node.name ?? "" });
    keyRows.sort((a, b) => a.n - b.n);
  }
  if (rows.length === 0 && keyRows.length === 0) return { svg: "", height: 0 };
  const ROW_H = 18;
  const PAD = 10;
  const colWidth = 150;
  const cols = Math.max(1, Math.min(4, Math.floor((width - PAD * 2) / colWidth)));
  const keyPerCol = Math.ceil(keyRows.length / cols);
  const perCol = Math.ceil(rows.length / cols);
  const keyBandH = keyRows.length > 0 ? keyPerCol * ROW_H : 0;
  const parts = [
    el("line", { x1: PAD, y1: 0.5, x2: width - PAD, y2: 0.5, stroke: "#c9c2b0", "stroke-width": 1 })
  ];
  keyRows.forEach((row, i) => {
    const col = Math.floor(i / keyPerCol);
    const x = PAD + col * colWidth;
    const y = PAD + i % keyPerCol * ROW_H + ROW_H / 2;
    parts.push(text(`${row.n}.`, { x: x + 12, y: y + 3.5, "font-size": 9, "font-weight": "bold", fill: INK, "text-anchor": "end", "font-family": "sans-serif" }));
    parts.push(text(row.name, { x: x + 18, y: y + 3.5, "font-size": 9, fill: INK, "font-family": "sans-serif" }));
  });
  rows.forEach((row, i) => {
    const col = Math.floor(i / perCol);
    const x = PAD + col * colWidth;
    const y = PAD + keyBandH + i % perCol * ROW_H + ROW_H / 2;
    const chain = model.chainOf(row.word);
    switch (row.kind) {
      case "fill":
        parts.push(el("rect", { x, y: y - 5, width: 14, height: 10, fill: model.theme.terrainFill(chain), stroke: "#b5ad99", "stroke-width": 0.5 }));
        break;
      case "stroke": {
        const s = model.theme.pathStroke(chain);
        parts.push(el("line", { x1: x, y1: y, x2: x + 14, y2: y, stroke: s.stroke, "stroke-width": 3, "stroke-dasharray": s.dash }));
        break;
      }
      case "barrier": {
        const fence = chain.includes("fence");
        parts.push(
          el("line", {
            x1: x,
            y1: y,
            x2: x + 14,
            y2: y,
            stroke: fence ? "#8a7a5c" : INK,
            "stroke-width": fence ? 2 : 3,
            "stroke-dasharray": fence ? "3 3" : void 0,
            "stroke-linecap": "square"
          })
        );
        break;
      }
      case "tier": {
        const tier = tierFor(chain);
        parts.push(el("circle", { cx: x + 7, cy: y, r: Math.min(5, tier.r), fill: "#3d3629" }));
        break;
      }
      case "glyph": {
        const themed = model.theme.glyphFor(chain, x, y);
        if (themed) {
          parts.push(
            `<path d="${themed}" transform="translate(${fmt(x + 7)} ${fmt(y)}) scale(0.5)" fill="none" stroke="${INK}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`
          );
        } else if (["campfire", "torch", "brazier", "lantern"].some((w) => chain.includes(w))) {
          parts.push(el("circle", { cx: x + 7, cy: y, r: 4, fill: "#d9822b", stroke: "#a8541e", "stroke-width": 1 }));
        } else if (chain.includes("stairs") || chain.includes("ramp")) {
          for (const [i2, w] of [5, 3.5, 2].entries()) {
            const ty = y + (i2 - 1) * 3;
            parts.push(el("line", { x1: x + 7 - w, y1: ty, x2: x + 7 + w, y2: ty, stroke: INK, "stroke-width": 1.4 }));
          }
        } else {
          const fill = model.theme.prop(chain, "fill") ?? wordTint(chain[chain.length - 1] ?? "");
          parts.push(el("rect", { x: x + 2, y: y - 5, width: 10, height: 10, fill, stroke: INK, "stroke-width": 1 }));
        }
        break;
      }
    }
    parts.push(text(row.word, { x: x + 20, y: y + 3.5, "font-size": 9, fill: INK, "font-family": "sans-serif" }));
  });
  return { svg: parts.join(""), height: PAD * 2 + keyBandH + (rows.length > 0 ? perCol * ROW_H : 0) };
}

// packages/render-svg/src/morphology.ts
function seawardSign(normal, seaward) {
  if (!seaward) return 1;
  return normal.x * seaward.x + normal.y * seaward.y >= 0 ? 1 : -1;
}
var ASPECT = 0.55;
var MIN_SIZE = 1e-6;
var SPACING = 2;
var MOUTH_FILLET = 0.25;
var MIN_HEAD = 0.08;
var PER_RADIUS = 12;
var MAX_POINTS = 6e3;
function resample(curve, spacing) {
  if (curve.length < 2) return curve;
  const arc = arcLengths(curve);
  const total = arc[arc.length - 1];
  if (total <= 0) return curve;
  const steps = Math.min(Math.max(Math.ceil(total / spacing), 2), MAX_POINTS);
  const out = [];
  let seg = 0;
  for (let i = 0; i <= steps; i++) {
    const target = total * i / steps;
    while (seg + 2 < curve.length && arc[seg + 1] < target) seg++;
    const a = curve[seg];
    const b = curve[seg + 1];
    const span = arc[seg + 1] - arc[seg];
    const t = span > 0 ? (target - arc[seg]) / span : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}
function deformCurve(curve, features, onReject, declared2 = true) {
  const host = declared2 ? resample(curve, SPACING) : curve;
  const arc = arcLengths(host);
  const total = arc[arc.length - 1] ?? 0;
  const accepted = [];
  let out = host;
  for (const f of features) {
    if (f.morph === "detached" || f.size < MIN_SIZE) continue;
    const sited = site(host, arc, f);
    if (sited === null || sited.at - sited.half <= 0 || sited.at + sited.half >= total) {
      onReject?.(f, { kind: "off-end" });
      continue;
    }
    const clash = accepted.find((g) => Math.abs(g.at - sited.at) < g.half + sited.half);
    if (clash) {
      onReject?.(f, { kind: "overlap", other: clash.f });
      continue;
    }
    const next = splice(host, arc, [...accepted, sited]);
    if (!isSimple(next) || !isSmooth(next)) {
      onReject?.(f, skewed(host, arc, accepted, f, sited) ?? pinched(host, arc, f, sited) ?? { kind: "fold" });
      continue;
    }
    accepted.push(sited);
    out = next;
  }
  return out;
}
function skewed(host, arc, accepted, f, sited) {
  const off = departure(f, sited);
  if (!off) return null;
  const trial = site(host, arc, { ...f, via: [off.suggest, ...f.via.slice(1)] });
  if (!trial) return null;
  const drawn = splice(host, arc, [...accepted, trial]);
  if (!isSimple(drawn) || !isSmooth(drawn)) return null;
  return { kind: "off-normal", degrees: off.degrees, suggest: off.suggest, leaves: off.leaves, normal: off.normal };
}
function departure(f, sited) {
  const via = f.via;
  const mouth = sited.centre[0];
  const lead = sited.centre[1];
  if (!via || via.length === 0 || !mouth || !lead) return null;
  const lx = lead.x - mouth.x;
  const ly = lead.y - mouth.y;
  const leadLen = Math.hypot(lx, ly);
  const vx = via[0].x - mouth.x;
  const vy = via[0].y - mouth.y;
  const legLen = Math.hypot(vx, vy);
  if (!(leadLen > 0) || !(legLen > 0)) return null;
  const cos = Math.min(1, Math.max(-1, (lx * vx + ly * vy) / (leadLen * legLen)));
  const degrees = Math.acos(cos) * 180 / Math.PI;
  if (degrees < 1) return null;
  return {
    degrees,
    suggest: { x: mouth.x + lx / leadLen * legLen, y: mouth.y + ly / leadLen * legLen },
    leaves: { x: vx / legLen, y: vy / legLen },
    normal: { x: lx / leadLen, y: ly / leadLen }
  };
}
function pinched(host, arc, f, sited) {
  let worst = null;
  const from = sited.at - sited.half;
  const to = sited.at + sited.half;
  ribbon(
    pointAtArc(host, arc, from),
    pointAtArc(host, arc, to),
    sited.centre,
    sited.f.taper ?? 1,
    sited.widths,
    (p2) => {
      worst = p2;
    }
  );
  const p = worst;
  if (p === null || !(p.half > 0) || p.radius > p.half * 1.5) return null;
  if (p.declaredFrom > 0 && p.s < p.declaredFrom) {
    const off = departure(f, sited);
    if (off) return { kind: "off-normal", degrees: off.degrees, leaves: off.leaves, normal: off.normal };
  }
  return { kind: "pinch", radius: p.radius, half: p.half, at: p.at };
}
function site(host, arc, f) {
  const i = nearestIndex(host, f.anchor);
  if (i < 0) return null;
  const dir = normalAt(host, i);
  const sign = (f.morph === "bite" ? -1 : 1) * seawardSign(dir, f.seaward);
  const mouth = host[i];
  const first = f.via?.[0];
  const along = first ? (first.x - mouth.x) * dir.x + (first.y - mouth.y) * dir.y : 0;
  const step = first ? (along >= 0 ? 1 : -1) * Math.hypot(first.x - mouth.x, first.y - mouth.y) * 0.3 : 0;
  const centre = f.via && f.via.length > 0 ? [mouth, { x: mouth.x + dir.x * step, y: mouth.y + dir.y * step }, ...f.via] : [mouth, { x: mouth.x + dir.x * sign * f.size * (f.reach ?? ASPECT), y: mouth.y + dir.y * sign * f.size * (f.reach ?? ASPECT) }];
  const widths = f.via && f.via.length > 0 ? [void 0, void 0, ...f.via.map((v) => v.width === void 0 ? void 0 : v.width / 2)] : [void 0, void 0];
  return { f, at: arc[i], half: f.size / 2, centre, widths };
}
function splice(host, arc, sited) {
  const order = [...sited].sort((a, b) => a.at - b.at);
  const out = [];
  let i = 0;
  for (const s of order) {
    const from = s.at - s.half;
    const to = s.at + s.half;
    while (i < host.length && arc[i] < from) out.push(host[i++]);
    out.push(...ribbon(pointAtArc(host, arc, from), pointAtArc(host, arc, to), s.centre, s.f.taper ?? 1, s.widths));
    while (i < host.length && arc[i] <= to) i++;
  }
  while (i < host.length) out.push(host[i++]);
  return out;
}
function ribbon(mouthA, mouthB, centre, taper, declared2 = [], probe) {
  const half = Math.hypot(mouthB.x - mouthA.x, mouthB.y - mouthA.y) / 2;
  const mid = { x: (mouthA.x + mouthB.x) / 2, y: (mouthA.y + mouthB.y) / 2 };
  const spined = centre.length > 2 ? catmullRom([mid, ...centre.slice(1)], 96) : [mid, ...centre.slice(1)];
  const path = resample(spined, Math.max(SPACING / 4, 1e-6));
  const arcs = arcLengths(path);
  const L = arcs[arcs.length - 1];
  if (!(L > 0) || !(half > 0)) return [mouthA, mouthB];
  const t = Math.min(Math.max(taper, 0), 1);
  const TINY = Math.max(half, L) * 1e-6;
  const r = MOUTH_FILLET * Math.min(half, L);
  const a = half - r;
  const b = Math.max(a * (1 - t), a * MIN_HEAD);
  const inner = L - b;
  const shallow = inner <= r;
  const profile = [];
  let cursor = 0;
  let declaredFrom = 0;
  for (let k = 1; k < centre.length; k++) {
    const found = arcAtNearest(path, arcs, centre[k], cursor);
    if (k === 2) declaredFrom = found;
    cursor = segmentAt(arcs, found).lo;
    const w = declared2[k];
    if (w !== void 0) profile.push({ at: found, half: w });
  }
  const stated = profile.length > 0;
  const prof = (s) => {
    if (!stated) return a;
    let prevAt = 0;
    let prevHalf = half;
    for (const point of profile) {
      if (s <= point.at) {
        const span2 = point.at - prevAt;
        const k = span2 > 0 ? (s - prevAt) / span2 : 1;
        const eased = (1 - Math.cos(Math.PI * Math.min(Math.max(k, 0), 1))) / 2;
        return prevHalf + (point.half - prevHalf) * eased;
      }
      prevAt = point.at;
      prevHalf = point.half;
    }
    return prevHalf;
  };
  const headHalf = stated ? Math.max(prof(L), Math.max(half, L) * 1e-3) : b;
  const headFrom = L - headHalf;
  const widthAt = (s) => {
    if (stated && !shallow) {
      if (s <= r) {
        const meets = prof(r);
        if (meets <= half) return half - (half - meets) * Math.sqrt(Math.max(0, 1 - (1 - s / r) ** 2));
        return half + (meets - half) * (s / r);
      }
      if (s >= headFrom) {
        return Math.sqrt(Math.max(0, headHalf * headHalf - (s - headFrom) ** 2));
      }
      return prof(s);
    }
    if (shallow) {
      return half * Math.sqrt(Math.max(0, 1 - (s / L) ** 2));
    }
    if (s <= r) return half - r * Math.sqrt(Math.max(0, 1 - (1 - s / r) ** 2));
    if (s >= inner) return Math.sqrt(Math.max(0, b * b - (s - inner) ** 2));
    const run = inner - r;
    const ramp = Math.max(t, 1e-6) * run;
    const flat = run - ramp;
    const n = s - r;
    return n <= flat ? a : b + (a - b) * 0.5 * (1 + Math.cos(Math.PI * (n - flat) / ramp));
  };
  const stops = [];
  const span = (steps, at) => {
    for (let i = 1; i <= steps; i++) stops.push(at(i / steps));
  };
  const QUARTER = Math.max(2, Math.ceil(PER_RADIUS * Math.PI / 2));
  stops.push(0);
  if (shallow) {
    span(Math.max(8, QUARTER * 2), (k) => L * Math.sin(k * Math.PI / 2));
  } else if (stated) {
    span(QUARTER, (k) => r * (1 - Math.cos(k * Math.PI / 2)));
    const flankFrom = r;
    const flankTo = Math.max(headFrom, r);
    const marks = /* @__PURE__ */ new Set([flankFrom, flankTo]);
    for (const point of profile) if (point.at > flankFrom && point.at < flankTo) marks.add(point.at);
    const ordered = [...marks].sort((x, y) => x - y);
    for (let k = 0; k + 1 < ordered.length; k++) {
      const from = ordered[k];
      const to = ordered[k + 1];
      const change = Math.abs(prof(to) - prof(from));
      const scale = Math.max(prof(from), prof(to), TINY);
      const steps = Math.max(2, Math.min(400, Math.ceil(change / scale * PER_RADIUS * 2)));
      for (let j = 1; j <= steps; j++) stops.push(from + (to - from) * j / steps);
    }
    span(QUARTER, (k) => headFrom + headHalf * Math.sin(k * Math.PI / 2));
  } else {
    span(QUARTER, (k) => r * (1 - Math.cos(k * Math.PI / 2)));
    const run = inner - r;
    const ramp = Math.max(t, 1e-6) * run;
    const R2 = a > b ? 2 * ramp * ramp / ((a - b) * Math.PI * Math.PI) : Infinity;
    const flankSteps = Math.max(2, Math.min(400, Math.ceil(run / Math.max(R2 / PER_RADIUS, run / 400))));
    span(flankSteps, (k) => r + run * k);
    span(QUARTER, (k) => inner + b * Math.sin(k * Math.PI / 2));
  }
  const radii2 = curvature(path, arcs);
  const tightest = Math.min(...radii2.filter((R2) => Number.isFinite(R2)));
  if (probe && !shallow) {
    let worst = null;
    for (let i = 1; i + 1 < path.length; i++) {
      const R2 = radii2[i];
      if (!Number.isFinite(R2)) continue;
      const w = widthAt(arcs[i]);
      if (w <= TINY) continue;
      if (worst === null || R2 / w < worst.radius / worst.half) {
        worst = { radius: R2, half: w, at: path[i], s: arcs[i], declaredFrom };
      }
    }
    if (worst) probe(worst);
  }
  stops.sort((x, y) => x - y);
  if (Number.isFinite(tightest) && tightest > 0) {
    const ceiling = Math.max(tightest / PER_RADIUS, L / 2e3);
    const filled = [];
    for (let i = 0; i < stops.length; i++) {
      const at = stops[i];
      filled.push(at);
      const next = i + 1 < stops.length ? stops[i + 1] : L;
      const span2 = next - at;
      if (span2 > ceiling) {
        const steps = Math.ceil(span2 / ceiling);
        for (let j = 1; j < steps; j++) filled.push(at + span2 * j / steps);
      }
    }
    stops.length = 0;
    stops.push(...filled);
  }
  const side = { x: (mouthB.x - mouthA.x) / (2 * half), y: (mouthB.y - mouthA.y) / (2 * half) };
  const tangents = path.map((_, i) => {
    const a2 = path[Math.max(0, i - 1)];
    const b2 = path[Math.min(path.length - 1, i + 1)];
    const dx = b2.x - a2.x;
    const dy = b2.y - a2.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  });
  const normalAt2 = (s) => {
    const p = pointAtArc(path, arcs, s);
    const { lo, k } = segmentAt(arcs, s);
    const a2 = tangents[lo];
    const b2 = tangents[Math.min(tangents.length - 1, lo + 1)];
    const tx = a2.x + (b2.x - a2.x) * k;
    const ty = a2.y + (b2.y - a2.y) * k;
    const len = Math.hypot(tx, ty) || 1;
    return { p, n: { x: -ty / len, y: tx / len } };
  };
  const flip = normalAt2(0).n.x * side.x + normalAt2(0).n.y * side.y < 0 ? -1 : 1;
  const frameAt = (s) => {
    const { p, n } = normalAt2(s);
    return { p, n: { x: n.x * flip, y: n.y * flip } };
  };
  const left = [];
  const right = [];
  for (const s of stops) {
    const { p, n } = frameAt(s);
    const raw = widthAt(s);
    const w = raw < TINY ? 0 : raw;
    left.push({ x: p.x - n.x * w, y: p.y - n.y * w });
    right.push({ x: p.x + n.x * w, y: p.y + n.y * w });
  }
  const ease = (rail, corner) => {
    const head = rail[0];
    if (!head || !(r > 0)) return;
    const dx = corner.x - head.x;
    const dy = corner.y - head.y;
    for (let i = 0; i < rail.length; i++) {
      const s = stops[i];
      if (s >= r) break;
      const k = 1 - s / r;
      rail[i] = { x: rail[i].x + dx * k, y: rail[i].y + dy * k };
    }
  };
  ease(left, mouthA);
  ease(right, mouthB);
  left[0] = mouthA;
  right[0] = mouthB;
  const out = [...left, ...right.reverse()];
  const gap = Math.max(TINY, Math.min(QUANTUM, Math.max(half, L) / 1e3));
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y) > gap);
}
function curvature(curve, arc) {
  const out = new Array(curve.length).fill(Infinity);
  for (let i = 1; i + 1 < curve.length; i++) {
    const a = curve[i - 1], b = curve[i], c = curve[i + 1];
    let turn = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    const ds = (arc[i + 1] - arc[i - 1]) / 2;
    out[i] = turn > 1e-9 && ds > 0 ? ds / turn : Infinity;
  }
  return out;
}
function segmentAt(arc, target) {
  const last = arc[arc.length - 1];
  if (!(target > 0)) return { lo: 0, k: 0 };
  if (target >= last) return { lo: Math.max(0, arc.length - 2), k: 1 };
  let lo = 0;
  let hi = arc.length - 1;
  while (lo + 1 < hi) {
    const mid = lo + hi >> 1;
    if (arc[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = arc[lo + 1] - arc[lo];
  return { lo, k: span > 0 ? (target - arc[lo]) / span : 0 };
}
function arcAtNearest(curve, arc, p, from = 0) {
  let best = from;
  let bestD = Infinity;
  for (let i = from; i < curve.length; i++) {
    const d = (curve[i].x - p.x) ** 2 + (curve[i].y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return arc[best];
}
function pointAtArc(curve, arc, target) {
  if (target <= 0) return curve[0];
  if (target >= arc[arc.length - 1]) return curve[curve.length - 1];
  const { lo, k } = segmentAt(arc, target);
  const a = curve[lo];
  const b = curve[lo + 1];
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}
function normalAt(curve, i) {
  const a = curve[Math.max(0, i - 1)];
  const b = curve[Math.min(curve.length - 1, i + 1)];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}
function arcLengths(curve) {
  const out = [0];
  for (let i = 1; i < curve.length; i++) {
    out.push(out[i - 1] + Math.hypot(curve[i].x - curve[i - 1].x, curve[i].y - curve[i - 1].y));
  }
  return out;
}
function nearestIndex(curve, p) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < curve.length; i++) {
    const d = Math.hypot(curve[i].x - p.x, curve[i].y - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
var MAX_TURN_DEGREES = 135;
function isSmooth(curve, limitDegrees = MAX_TURN_DEGREES) {
  const limit = limitDegrees * Math.PI / 180;
  for (let i = 1; i + 1 < curve.length; i++) {
    const a = curve[i - 1], b = curve[i], c = curve[i + 1];
    let turn = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > limit) return false;
  }
  return true;
}
function isSimple(curve) {
  const segs = curve.length - 1;
  if (segs < 2) return true;
  const first = curve[0];
  const last = curve[curve.length - 1];
  const closed = curve.length > 2 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-9;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of curve) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const cell = Math.max(Math.hypot(maxX - minX, maxY - minY) / Math.max(16, Math.sqrt(segs)), 1e-9);
  const cols = Math.floor((maxX - minX) / cell) + 1;
  const buckets = /* @__PURE__ */ new Map();
  const cellsOf = (i) => {
    const a = curve[i], b = curve[i + 1];
    const gx0 = Math.floor((Math.min(a.x, b.x) - minX) / cell);
    const gx1 = Math.floor((Math.max(a.x, b.x) - minX) / cell);
    const gy0 = Math.floor((Math.min(a.y, b.y) - minY) / cell);
    const gy1 = Math.floor((Math.max(a.y, b.y) - minY) / cell);
    const keys = [];
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) keys.push(gy * cols + gx);
    return keys;
  };
  for (let i = 0; i < segs; i++) {
    for (const key of cellsOf(i)) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i);
      else buckets.set(key, [i]);
    }
  }
  const tested = /* @__PURE__ */ new Set();
  for (let i = 0; i < segs; i++) {
    tested.clear();
    for (const key of cellsOf(i)) {
      for (const j of buckets.get(key) ?? []) {
        if (j < i + 2 || tested.has(j)) continue;
        tested.add(j);
        if (closed && i === 0 && j === segs - 1) continue;
        if (segmentsCross(curve[i], curve[i + 1], curve[j], curve[j + 1])) return false;
      }
    }
  }
  return true;
}
function segmentsCross(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  const EPS = 1e-9;
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS;
}

// packages/render-svg/src/channel.ts
var CHANNEL_FLOOR = 2;
var boxOf = (ring) => ({
  x0: Math.min(...ring.map((p) => p.x)),
  y0: Math.min(...ring.map((p) => p.y)),
  x1: Math.max(...ring.map((p) => p.x)),
  y1: Math.max(...ring.map((p) => p.y))
});
var grow = (b, by) => ({ x0: b.x0 - by, y0: b.y0 - by, x1: b.x1 + by, y1: b.y1 + by });
var overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
function sampleRing(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const parts = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < parts; s++) {
      out.push({ x: a.x + (b.x - a.x) * s / parts, y: a.y + (b.y - a.y) * s / parts });
    }
  }
  return out;
}
function thin(pts, tol) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i + 1];
    const p = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    if (Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len > tol) out.push(p);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function narrowChannels(islands, waters, frame, floor = CHANNEL_FLOOR) {
  if (!islands.length || !waters.length && islands.length < 2) return [];
  const waterAt = (p) => {
    for (const isle of islands) if (pip(p, isle)) return -1;
    for (let k = 0; k < waters.length; k++) if (pip(p, waters[k])) return k;
    return -1;
  };
  const EDGE = 0.05;
  const onFrame = (a, b) => Math.abs(a.x) < EDGE && Math.abs(b.x) < EDGE || Math.abs(a.y) < EDGE && Math.abs(b.y) < EDGE || Math.abs(a.x - frame.width) < EDGE && Math.abs(b.x - frame.width) < EDGE || Math.abs(a.y - frame.height) < EDGE && Math.abs(b.y - frame.height) < EDGE;
  const out = [];
  const pairs = [];
  for (let i = 0; i < islands.length; i++) {
    for (const water of waters) pairs.push([islands[i], water]);
    for (let j = i + 1; j < islands.length; j++) {
      const [a, b] = [islands[i], islands[j]];
      pairs.push(a.length <= b.length ? [a, b] : [b, a]);
    }
  }
  for (const [ring, other] of pairs) {
    const near = grow(boxOf(ring), floor);
    const segs = [];
    for (let i = 0; i < other.length; i++) {
      const a = other[i];
      const b = other[(i + 1) % other.length];
      if (onFrame(a, b)) continue;
      if (!overlaps(near, boxOf([a, b]))) continue;
      segs.push([a, b]);
    }
    if (!segs.length) continue;
    let perim = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      perim += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const step = Math.max(floor / 2, perim / 6e3);
    const samples = sampleRing(ring, step);
    const hits = samples.map((p) => {
      let bestD = Infinity;
      let best = null;
      for (const [a, b] of segs) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
        const q = { x: a.x + t * dx, y: a.y + t * dy };
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      if (!best || bestD >= floor || bestD <= QUANTUM) return null;
      const mid = { x: (p.x + best.x) / 2, y: (p.y + best.y) / 2 };
      const water = waterAt(mid);
      return water < 0 ? null : { mid, d: bestD, water };
    });
    const start = hits.findIndex((h) => h === null);
    if (start < 0) continue;
    let run = [];
    const flush = () => {
      if (run.length >= 3) {
        out.push({
          spine: thin(run.map((r) => r.mid), floor / 6),
          narrowest: Math.min(...run.map((r) => r.d)),
          water: run[0].water
        });
      }
      run = [];
    };
    for (let k = 1; k <= hits.length; k++) {
      const hit = hits[(start + k) % hits.length];
      const jumped = hit && run.length && Math.hypot(hit.mid.x - run[run.length - 1].mid.x, hit.mid.y - run[run.length - 1].mid.y) > step * 4;
      if (!hit || jumped) {
        flush();
        if (hit) run.push(hit);
        continue;
      }
      run.push(hit);
    }
    flush();
  }
  return out;
}

// packages/render-svg/src/region.ts
function renderRegion(model, body, size, diagnostics = []) {
  const { w, h, scale } = size;
  const theme = model.theme;
  const ink = theme.surface("ink", "fill", INK);
  const groundWord = model.header.get("ground")?.trim();
  const groundFill = groundWord ? theme.terrainFill(groundWord.split(/\s+/)) : null;
  if (groundFill) body.push(el("rect", { x: 0, y: 0, width: w, height: h, fill: groundFill }));
  const resolved = /* @__PURE__ */ new Map();
  const byName = /* @__PURE__ */ new Map();
  let waterVector = null;
  const keyOf2 = (e) => entityAnchor(e) ?? `@anon-${e.line}`;
  const lookup = (ref) => resolved.get(ref.form === "id" ? ref.value : byName.get(ref.value) ?? slugify(ref.value));
  const toXY = (p) => ({ x: p.x * scale, y: p.y * scale });
  const round1 = (n) => String(Math.round(n * 10) / 10);
  const mapUnit = /^(\d+)x(\d+)([a-z]*)$/.exec(model.header.get("extent") ?? "")?.[3] ?? "";
  const refText = (ref) => ref.value;
  const seawardByHost = /* @__PURE__ */ new Map();
  const hostControls = /* @__PURE__ */ new Map();
  for (const e of model.entities) {
    const pts = [];
    for (const p of e.placements) {
      if (p.kind === "shape") pts.push(...p.args.filter((a) => a.kind === "point").map(toXY));
      else if (p.kind === "relational" && p.form === "from-to") {
        for (const ep of [p.from, ...p.via, p.to]) {
          const at = "at" in ep ? ep.at : ep;
          if (at && at.kind === "point") pts.push(toXY(at));
        }
      }
    }
    if (pts.length >= 2) for (const k of [...e.ids, ...e.name ? [e.name] : []]) hostControls.set(k, pts);
  }
  const undeformed = (key) => {
    const controls = hostControls.get(key);
    return controls && controls.length >= 2 ? catmullRom(controls, 8) : null;
  };
  const provisionalWater = (hostKey) => {
    const course = undeformed(hostKey);
    if (!course) return [];
    const out = [];
    for (const e of model.entities) {
      if (e.section !== "water") continue;
      for (const p of e.placements) {
        if (p.kind === "relational" && p.form === "side-of" && refText(p.ref) === hostKey) {
          out.push(halfPlanePolygon({ compass: p.compass, of: course }, w, h));
          continue;
        }
        if (p.kind !== "shape" || p.shape !== "area") continue;
        const follows = p.args.some((a) => a.kind === "relational" && a.form === "along" && refText(a.ref) === hostKey);
        if (!follows) continue;
        const ring = [];
        for (const arg of p.args) {
          if (arg.kind === "point") ring.push(toXY(arg));
          else if (arg.kind === "relational" && arg.form === "along" && refText(arg.ref) === hostKey) {
            const head = ring[ring.length - 1];
            const forward = !head || Math.hypot(course[0].x - head.x, course[0].y - head.y) <= Math.hypot(course[course.length - 1].x - head.x, course[course.length - 1].y - head.y);
            ring.push(...forward ? course : [...course].reverse());
          }
        }
        if (ring.length >= 3) out.push(ring);
      }
    }
    return out;
  };
  const localSeaward = (hostKey, at) => {
    const course = undeformed(hostKey);
    const bodies = provisionalWater(hostKey);
    if (!course || bodies.length === 0) return null;
    let on = course[0];
    let seg = { x: 1, y: 0 };
    let bestD = Infinity;
    for (let i = 1; i < course.length; i++) {
      const a = course[i - 1];
      const b = course[i];
      const p = nearestOnSegment(a, b, at);
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < bestD && len > 0) {
        bestD = d;
        on = p;
        seg = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      }
    }
    if (!Number.isFinite(bestD)) return null;
    const n = { x: -seg.y, y: seg.x };
    const step = Math.max(w, h) / 400;
    const wet = (s) => bodies.some((body2) => pip({ x: on.x + n.x * s, y: on.y + n.y * s }, body2));
    const plus = wet(step);
    const minus = wet(-step);
    if (plus === minus) return "ambiguous";
    return plus ? n : { x: -n.x, y: -n.y };
  };
  const waterCentres = [];
  for (const e of model.entities) {
    if (e.section !== "water") continue;
    for (const p of e.placements) {
      if (p.kind === "relational" && p.form === "side-of") {
        const vec = COMPASS_VECTORS[p.compass];
        if (vec) seawardByHost.set(refText(p.ref), vec);
        continue;
      }
      if (p.kind !== "shape" || p.shape !== "area" && p.shape !== "blob") continue;
      const pts = p.args.filter((a) => a.kind === "point").map(toXY);
      if (pts.length >= 3) {
        waterCentres.push({
          x: pts.reduce((t, q) => t + q.x, 0) / pts.length,
          y: pts.reduce((t, q) => t + q.y, 0) / pts.length
        });
      }
    }
  }
  const featuresByHost = /* @__PURE__ */ new Map();
  for (const e of model.entities) {
    const morph = model.facetOf(e.typeWord, "morph");
    if (!morph || morph === "detached") continue;
    for (const p of e.placements) {
      if (p.kind !== "relational" || p.form !== "on" || !p.point) continue;
      const host = refText(p.ref);
      const sizeText = pairOf(e.pairs, "size");
      if (sizeText === void 0) {
        diagnostics.push({ severity: "warning", line: e.line, message: `'${e.typeWord}' on '${host}' has no size= \u2014 a placed feature needs an extent along its host to be drawn (spec 05 \xA74)` });
        continue;
      }
      const anchorXY = toXY(p.point);
      const local = localSeaward(host, anchorXY);
      const statesCourse = (p.via?.length ?? 0) > 0;
      if (local === "ambiguous" && !statesCourse) {
        const named = e.name === void 0 ? `'${e.typeWord}'` : `'${e.name}' (${e.typeWord})`;
        diagnostics.push({
          severity: "error",
          line: e.line,
          message: `${named} cannot be drawn on '${host}' \u2014 the water's declaration does not say which side of '${host}' it lies on here: both sides read the same, so which way this faces would be a guess. Declare the sea as an area following its shores, or state the feature's own course with via (spec 05 \xA74)`
        });
        continue;
      }
      let seaward = (local && local !== "ambiguous" ? local : void 0) ?? seawardByHost.get(host);
      if (!seaward && waterCentres.length > 0) {
        let best = waterCentres[0];
        for (const c of waterCentres) {
          if (Math.hypot(c.x - anchorXY.x, c.y - anchorXY.y) < Math.hypot(best.x - anchorXY.x, best.y - anchorXY.y)) best = c;
        }
        const dx = best.x - anchorXY.x;
        const dy = best.y - anchorXY.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-9) seaward = { x: dx / len, y: dy / len };
      }
      const hostedOnFeature = model.entities.some(
        (other) => other !== e && [...other.ids, ...other.name ? [other.name] : []].includes(host) && model.facetOf(other.typeWord, "morph") !== void 0
      );
      if (!seaward && !hostedOnFeature) {
        diagnostics.push({ severity: "warning", line: e.line, message: `nothing on this map says which side of '${host}' the water is on, so '${e.typeWord}' cannot know which way to face \u2014 declare an open coast's sea with 'sea : west of ${host}', or an enclosed one as an area following its shores (spec 05 \xA74)` });
      }
      const numericFacet = (key) => {
        const text2 = pairOf(e.pairs, key) ?? model.facetOf(e.typeWord, key);
        if (text2 === void 0) return void 0;
        const value = Number(text2);
        if (!Number.isFinite(value)) {
          diagnostics.push({ severity: "warning", line: e.line, message: `'${key}=${text2}' is not a number \u2014 the vocabulary default applies (spec 05 \xA74)` });
          return void 0;
        }
        return value;
      };
      const reach = numericFacet("reach");
      const taper = numericFacet("taper");
      const via = p.via?.map((c) => ({
        ...toXY(c),
        ...c.width === void 0 ? {} : { width: measureToNumber(c.width) * scale }
      }));
      if (via && pairOf(e.pairs, "reach") !== void 0) {
        diagnostics.push({
          severity: "error",
          line: e.line,
          message: `'${e.name ?? e.typeWord}' declares a centerline with 'via' AND reach= \u2014 'via' says where the feature runs and reach= generates a straight run instead, so one would have to be discarded. Drop reach=, or drop the via points (spec 05 \xA74)`
        });
        continue;
      }
      const entry = {
        f: { morph, anchor: anchorXY, size: measureToNumber(sizeText) * scale, ...seaward ? { seaward } : {}, ...reach !== void 0 ? { reach } : {}, ...taper !== void 0 ? { taper } : {}, ...via && via.length > 0 ? { via } : {} },
        // The ENTITY as the author would recognise it: three `sound`s on one
        // coast all reported as "'sound'" gave nothing to tell them apart
        // (#156). And `sizeText` is carried verbatim rather than recomputed
        // from pixels, because rounding it turned `size=1.5mi` into `size=2`
        // and read as though the edit had not been saved.
        label: e.name ?? e.ids[0] ?? e.typeWord ?? "feature",
        word: e.typeWord ?? "feature",
        sizeText,
        morph,
        line: e.line,
        keys: [...e.ids, ...e.name ? [e.name] : []],
        host
      };
      const list = featuresByHost.get(host) ?? [];
      list.push(entry);
      featuresByHost.set(host, list);
    }
  }
  const channelAxisAt = (pt) => {
    let best;
    for (const entry of [...featuresByHost.values()].flat()) {
      if (entry.morph !== "bite") continue;
      const seaward = entry.f.seaward;
      if (!seaward) continue;
      const axis = { x: -seaward.x, y: -seaward.y };
      const depth = entry.f.size * (entry.f.reach ?? ASPECT);
      const dx = pt.x - entry.f.anchor.x;
      const dy = pt.y - entry.f.anchor.y;
      const along = dx * axis.x + dy * axis.y;
      const across = dx * -axis.y + dy * axis.x;
      if (along < 0 || along > depth || Math.abs(across) > entry.f.size / 2) continue;
      const area = entry.f.size * depth;
      const better = !best || area < best.area || area === best.area && (entry.f.anchor.x - best.anchor.x || entry.f.anchor.y - best.anchor.y || entry.line - best.line) < 0;
      if (better) best = { axis, area, anchor: entry.f.anchor, line: entry.line };
    }
    return best ? Math.atan2(best.axis.y, best.axis.x) : void 0;
  };
  const refused = /* @__PURE__ */ new Set();
  for (const list of featuresByHost.values()) {
    for (const arm of list) {
      const host = [...featuresByHost.values()].flat().find((h2) => h2.keys.includes(arm.host));
      const stated = host?.f.via && host.f.via.length > 0;
      if (!host || !stated && !host.f.seaward) continue;
      const back = { x: -(host.f.seaward?.x ?? 0), y: -(host.f.seaward?.y ?? 0) };
      const depth = host.f.size * (host.f.reach ?? ASPECT);
      const line = stated ? [host.f.anchor, ...host.f.via] : [host.f.anchor, { x: host.f.anchor.x + back.x * depth, y: host.f.anchor.y + back.y * depth }];
      let best = null;
      let bestD = Infinity;
      let along = null;
      for (let i = 1; i < line.length; i++) {
        const p = nearestOnSegment(line[i - 1], line[i], arm.f.anchor);
        const d = Math.hypot(p.x - arm.f.anchor.x, p.y - arm.f.anchor.y);
        if (d < bestD) {
          bestD = d;
          best = p;
          const dx = line[i].x - line[i - 1].x;
          const dy = line[i].y - line[i - 1].y;
          const len = Math.hypot(dx, dy);
          along = len > 0 ? { x: dx / len, y: dy / len } : null;
        }
      }
      if (!best) continue;
      if (bestD <= Math.max(host.f.size, 1) * 1e-9) {
        const named = arm.label === arm.word ? `'${arm.word}'` : `'${arm.label}' (${arm.word})`;
        const half = host.f.size / 2;
        const banks = along ? [1, -1].map(
          (s) => `(${round1((best.x - along.y * half * s) / scale)},${round1((best.y + along.x * half * s) / scale)})`
        ).join(" or ") : "either side of it";
        diagnostics.push({
          severity: "error",
          line: arm.line,
          message: `${named} cannot be drawn on '${arm.host}' \u2014 its anchor lies on the centerline of '${arm.host}', which does not say which bank it leaves from. Move it to one: about ${banks} (spec 05 \xA74)`
        });
        refused.add(arm);
        continue;
      }
      arm.f.seaward = { x: (best.x - arm.f.anchor.x) / bestD, y: (best.y - arm.f.anchor.y) / bestD };
    }
  }
  for (const [key, list] of featuresByHost) {
    if (list.some((x) => refused.has(x))) featuresByHost.set(key, list.filter((x) => !refused.has(x)));
  }
  const featureLabelPoint = (e, anchor, via, hostKey) => {
    const morph = model.facetOf(e.typeWord, "morph");
    if (morph !== "jut" && morph !== "bite") return null;
    if (via && via.length > 0) {
      const line = [anchor, ...via];
      const lengths = line.map((p, i) => i === 0 ? 0 : Math.hypot(p.x - line[i - 1].x, p.y - line[i - 1].y));
      const total = lengths.reduce((s, d) => s + d, 0);
      let walked = 0;
      for (let i = 1; i < line.length; i++) {
        if (walked + lengths[i] >= total / 2) {
          const k = lengths[i] > 0 ? (total / 2 - walked) / lengths[i] : 0;
          return { x: line[i - 1].x + (line[i].x - line[i - 1].x) * k, y: line[i - 1].y + (line[i].y - line[i - 1].y) * k };
        }
        walked += lengths[i];
      }
      return line[line.length - 1];
    }
    const sizeText = pairOf(e.pairs, "size");
    const seaward = seawardByHost.get(hostKey);
    if (sizeText === void 0 || !seaward) return null;
    const reachText = pairOf(e.pairs, "reach") ?? model.facetOf(e.typeWord, "reach");
    const reach = reachText === void 0 ? ASPECT : Number(reachText);
    if (!Number.isFinite(reach)) return null;
    const step = (morph === "bite" ? -1 : 1) * (measureToNumber(sizeText) * scale * reach) / 2;
    return { x: anchor.x + seaward.x * step, y: anchor.y + seaward.y * step };
  };
  const hostKeys = (e) => [...e.ids, ...e.name ? [e.name] : []];
  const finishCourse = (e, controls) => {
    const placed = hostKeys(e).flatMap((k) => featuresByHost.get(k) ?? []);
    if (placed.length === 0) return catmullRom(controls, 8);
    const curve = catmullRom(controls, 8);
    const arms = placed.flatMap((x) => x.keys.flatMap((k) => featuresByHost.get(k) ?? []));
    const byFeature = new Map([...placed, ...arms].map((x) => [x.f, x]));
    const passes = arms.length > 0 ? [placed, arms] : [placed];
    return passes.reduce((into, pass, index) => deformCurve(into, pass.map((x) => x.f), (f, why) => {
      const x = byFeature.get(f);
      if (!x) return;
      const named = (y) => y.label === y.word ? `'${y.word}'` : `'${y.label}' (${y.word})`;
      const because = why.kind === "off-end" ? `half of its mouth would lie off the end of '${keyOf2(e)}'. Move it further along the course, or use a smaller size=` : why.kind === "overlap" ? `it claims the same stretch of '${keyOf2(e)}' as ${named(byFeature.get(why.other) ?? x)}. Move one of them, or use a smaller size= on either` : why.kind === "off-normal" ? why.suggest ? `its centerline leaves the host at ${Math.round(why.degrees)}\xB0 from the normal, and a centerline must leave perpendicular. Try a first via point at (${round1(why.suggest.x / scale)},${round1(why.suggest.y / scale)})` : `its centerline leaves the host at ${Math.round(why.degrees)}\xB0 from the normal, and squaring the first via point is not enough to draw it \u2014 so this feature is on the wrong stretch of coast, or this coast is not the one it was drawn against. It leaves heading (${round1(why.leaves.x)},${round1(why.leaves.y)}) while the shore here faces (${round1(why.normal.x)},${round1(why.normal.y)})` : why.kind === "pinch" ? `its centerline turns with a radius of ${round1(why.radius / scale)} near (${round1(why.at.x / scale)},${round1(why.at.y / scale)}), and a channel cannot follow a turn tighter than its own half-width \u2014 ${round1(why.half / scale)} there. Spread the via points through that bend, or narrow the channel there` : `${x.morph === "jut" ? "a jut that long" : "a bite that deep"} would fold this stretch of the course back through itself. Use a smaller size= or reach=, or move it to a straighter stretch`;
      const at = why.kind === "off-normal" || why.kind === "pinch" ? "" : ` at size=${x.sizeText}`;
      diagnostics.push({
        severity: "error",
        line: x.line,
        message: `${named(x)} cannot be drawn${at} on '${x.host}' \u2014 ${because} (spec 05 \xA74)`
      });
    }, index === 0), curve);
  };
  const refPoint = (ref) => {
    const r = lookup(ref);
    if (!r) return null;
    if (r.point) return r.point;
    if (r.polyline) return r.polyline[Math.floor(r.polyline.length / 2)];
    if (r.polygon) return centroid(r.polygon);
    return null;
  };
  const coastCurves = [];
  const massRng = (word, size2) => rng(hashSeed(hashString(word ?? "mass"), Math.round(size2 * 1e3)));
  const near = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  const runMatches = (pts, start, raw, reversed) => {
    if (start + raw.length > pts.length) return false;
    for (let k = 0; k < raw.length; k++) {
      const r = reversed ? raw[raw.length - 1 - k] : raw[k];
      if (!near(pts[start + k], r)) return false;
    }
    return true;
  };
  const assembleWaterBoundary = (pts) => {
    const out = [];
    let i = 0;
    while (i < pts.length) {
      let advanced = false;
      for (const c of coastCurves) {
        if (c.raw.length >= 2 && runMatches(pts, i, c.raw, false)) {
          out.push(...c.finished);
          i += c.raw.length;
          advanced = true;
          break;
        }
        if (c.raw.length >= 2 && runMatches(pts, i, c.raw, true)) {
          out.push(...[...c.finished].reverse());
          i += c.raw.length;
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        out.push(pts[i]);
        i++;
      }
    }
    return out;
  };
  const ringPathBetween = (ring, a, b, face) => {
    const closed = [...ring, ring[0]];
    const param = (target) => {
      let best = { d: Infinity, i: 0, p: closed[0] };
      for (let i = 0; i < closed.length - 1; i++) {
        const p1 = closed[i];
        const p2 = closed[i + 1];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const lenSq = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((target.x - p1.x) * dx + (target.y - p1.y) * dy) / lenSq));
        const p = { x: p1.x + t * dx, y: p1.y + t * dy };
        const d = Math.hypot(p.x - target.x, p.y - target.y);
        if (d < best.d) best = { d, i, p };
      }
      return best;
    };
    const pa = param(a);
    const pb = param(b);
    const n = ring.length;
    const walk2 = (forward) => {
      const out = [pa.p];
      let i = pa.i;
      while (i !== pb.i) {
        i = forward ? (i + 1) % n : (i - 1 + n) % n;
        out.push(ring[forward ? i : (i + 1) % n]);
        if (out.length > n + 2) break;
      }
      out.push(pb.p);
      return out;
    };
    const arcs = [walk2(true), walk2(false)];
    const vec = COMPASS_VECTORS[face] ?? { x: 0, y: -1 };
    const score = (arc) => arc.reduce((s, p) => s + p.x * vec.x + p.y * vec.y, 0) / arc.length;
    return score(arcs[0]) >= score(arcs[1]) ? arcs[0] : arcs[1];
  };
  const lineAspect = (ref, face, a, b, line) => {
    const target = lookup(ref);
    if (face && target?.polygon && a && b) return ringPathBetween(target.polygon, a, b, face);
    if (target?.polyline) return a && b ? subPolylineBetween(target.polyline, a, b) : target.polyline;
    if (target?.polygon) {
      diagnostics.push({ severity: "warning", line, message: `along ${ref.value} is ambiguous: it is an area with no crest line \u2014 name a face: along <compass> edge of ${ref.value} (ADR 0013)` });
    }
    return null;
  };
  const resolveEntity = (e) => {
    const chain = model.chainOf(e.typeWord);
    const out = {};
    let onRef = null;
    if (model.facetOf(e.typeWord, "morph") === "detached") {
      const anchor = e.placements.find((p) => p.kind === "point") ?? e.placements.flatMap((p) => p.kind === "relational" && p.form === "at" && p.target.kind === "point" ? [p.target] : [])[0];
      const sizeText = pairOf(e.pairs, "size");
      const outline = e.placements.find(
        (p) => p.kind === "shape" && p.shape === "area"
      );
      if (anchor && outline) {
        const dials = ["size", "reach", "taper"].filter((k) => pairOf(e.pairs, k) !== void 0);
        if (dials.length > 0) {
          diagnostics.push({
            severity: "error",
            line: e.line,
            message: `'${e.name ?? e.typeWord}' declares an outline AND ${dials.map((d) => `${d}=`).join(", ")} \u2014 an outline says what the feature looks like and the dials generate a shape instead, so one would have to be discarded. Drop ${dials.map((d) => `${d}=`).join("/")}, or drop the outline (spec 05 \xA74)`
          });
          return out;
        }
        const centre = toXY(anchor);
        const framed = outline.args.filter((arg) => arg.kind === "point").map((arg) => ({ x: centre.x + arg.x * scale, y: centre.y + arg.y * scale }));
        if (framed.length >= 3) {
          out.polygon = organicOutline(framed, hashSeed(hashString(e.typeWord ?? "island"), framed.length));
          out.point = centre;
          return out;
        }
        diagnostics.push({
          severity: "warning",
          line: e.line,
          message: `'${e.name ?? e.typeWord}' has an outline of ${framed.length} point${framed.length === 1 ? "" : "s"} \u2014 an outline needs at least three (spec 05 \xA74)`
        });
        return out;
      }
      if (anchor && sizeText !== void 0) {
        const center = toXY(anchor);
        const radius = measureToNumber(sizeText) / 2 * scale;
        const reachText = pairOf(e.pairs, "reach") ?? model.facetOf(e.typeWord, "reach");
        const reachNum = reachText === void 0 ? 1 : Number(reachText);
        if (reachText !== void 0 && !Number.isFinite(reachNum)) {
          diagnostics.push({ severity: "warning", line: e.line, message: `'reach=${reachText}' is not a number \u2014 the vocabulary default applies (spec 05 \xA74)` });
        }
        const shortRatio = Number.isFinite(reachNum) && reachNum > 0 ? reachNum : 1;
        const hostRef = e.placements.find((p) => p.kind === "relational" && p.form === "near" && p.target.kind === "ref");
        const controls = hostRef && hostRef.target.kind === "ref" ? hostControls.get(hostRef.target.value) : void 0;
        const angle = channelAxisAt(center) ?? (controls ? tangentAngle(controls, center) : 0);
        out.polygon = organicMass(center, radius * 2, shortRatio, angle, massRng(e.typeWord ?? void 0, radius * 2));
        out.point = center;
        out.radius = radius;
        return out;
      }
      if (anchor && sizeText === void 0) {
        diagnostics.push({ severity: "warning", line: e.line, message: `'${e.typeWord}' has no size= \u2014 a placed feature needs an extent to be drawn (spec 05 \xA74)` });
      }
    }
    for (const p of e.placements) {
      if (p.kind === "point") out.point = toXY(p);
      else if (p.kind === "point-range") {
        const a = toXY(p.from);
        const b = toXY(p.to);
        out.polygon = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      } else if (p.kind === "shape") {
        let origin = null;
        if (p.frame) {
          origin = refPoint(p.frame);
          if (!origin) {
            diagnostics.push({ severity: "warning", line: e.line, message: `'${p.frame.value}' has no position to frame this ${p.shape} against \u2014 its offsets are read as absolute (spec 02 \xA79)` });
          }
        }
        const framed = (pt) => origin ? { x: origin.x + pt.x, y: origin.y + pt.y } : pt;
        const pts = p.args.filter((arg) => arg.kind === "point").map((arg) => origin ? framed({ x: arg.x * scale, y: arg.y * scale }) : toXY(arg));
        if (p.shape === "blob") {
          const center = pts[0] ?? out.point ?? { x: w / 2, y: h / 2 };
          const diameter = measureToNumber(pairOf(e.pairs, "size") ?? "40") * scale;
          out.polygon = organicMass(center, diameter, 1, 0, massRng(e.typeWord ?? void 0, diameter));
          out.point = center;
          out.radius = diameter / 2;
        } else if (p.shape === "area") {
          const spliced = [];
          const spans = [];
          for (let k = 0; k < p.args.length; k++) {
            const arg = p.args[k];
            if (arg.kind === "point") {
              spliced.push(toXY(arg));
              continue;
            }
            if (arg.kind !== "relational" || arg.form !== "along") continue;
            const prev = spliced[spliced.length - 1];
            let next = null;
            for (let m = k + 1; m < p.args.length; m++) {
              const b = p.args[m];
              if (b.kind === "point") {
                next = toXY(b);
                break;
              }
            }
            next ??= spliced[0] ?? null;
            if (prev && next) {
              const seg = lineAspect(arg.ref, arg.face, prev, next, e.line);
              if (seg) {
                const refKey = arg.ref.form === "id" ? arg.ref.value : byName.get(arg.ref.value) ?? slugify(arg.ref.value);
                spans.push({ ref: arg.ref.value, refKey, start: spliced.length - 1, end: spliced.length + seg.length });
                spliced.push(...seg);
              }
            }
          }
          if (spans.length) out.alongSpans = spans;
          const literal = e.flags.includes("raw") || e.section === "water" || spans.length > 0;
          out.polygon = e.section === "water" ? assembleWaterBoundary(spliced) : literal || e.archetype !== "terrain" || spliced.length < 3 ? spliced : organicOutline(spliced, hashSeed(model.seed, hashString(entityAnchor(e) ?? e.typeWord ?? "area"), spliced.length));
        } else {
          out.polyline = finishCourse(e, pts);
          out.ridge = p.shape === "ridge";
          if (out.ridge) {
            const declared2 = pairOf(e.pairs, "width");
            out.beltW = declared2 ? measureToNumber(declared2) * scale : 28;
          }
          if (chain.includes("coastline")) coastCurves.push({ raw: pts, finished: out.polyline });
        }
      } else if (p.kind === "relational") {
        switch (p.form) {
          case "at":
            if (p.target.kind === "point") out.point = toXY(p.target);
            break;
          case "offset-of": {
            const base = refPoint(p.ref);
            if (base) {
              const vec = COMPASS_VECTORS[p.compass];
              const d = measureToNumber(p.measure) * scale;
              out.point = { x: base.x + vec.x * d, y: base.y + vec.y * d };
            }
            break;
          }
          case "side-of": {
            const r = lookup(p.ref);
            if (r?.polyline) out.halfPlane = { compass: p.compass, of: r.polyline, refKey: p.ref.form === "id" ? p.ref.value : byName.get(p.ref.value) ?? slugify(p.ref.value) };
            else {
              const base = refPoint(p.ref);
              if (base) {
                const vec = COMPASS_VECTORS[p.compass];
                out.point = { x: base.x + vec.x * 40, y: base.y + vec.y * 40 };
              }
            }
            break;
          }
          case "edge-of": {
            const base = refPoint(p.ref);
            if (base) {
              const vec = COMPASS_VECTORS[p.compass];
              const reach = lookup(p.ref)?.radius ?? 30;
              out.point = { x: base.x + vec.x * reach, y: base.y + vec.y * reach };
            }
            break;
          }
          case "on":
            onRef = p.ref;
            if (p.point) out.point = featureLabelPoint(e, toXY(p.point), p.via?.map(toXY), refText(p.ref)) ?? toXY(p.point);
            break;
          case "near": {
            const target = p.target.kind === "point" ? toXY(p.target) : refPoint(p.target);
            if (target) out.point = { x: target.x + 8, y: target.y + 8 };
            break;
          }
          case "from-to": {
            const ring = (poly) => [...poly, poly[0]];
            const resolveEnd = (ep) => {
              if (ep.at.kind === "point") return { p: toXY(ep.at), shore: null };
              const target = lookup(ep.at);
              if (ep.join) {
                if (!target?.polyline) {
                  diagnostics.push({ severity: "warning", line: e.line, message: `'join ${ep.at.value}' needs a watercourse with a course to meet and that one has none \u2014 the endpoint falls back to its position (spec 02 \xA77)` });
                  return { p: refPoint(ep.at), shore: null };
                }
                return { p: refPoint(ep.at), shore: target.polyline };
              }
              if (ep.point) {
                const raw = toXY(ep.point);
                if (target?.polyline) return { p: nearestOnPolyline(target.polyline, raw), shore: null };
                if (target?.polygon) return { p: nearestOnPolyline(ring(target.polygon), raw), shore: null };
                return { p: raw, shore: null };
              }
              return { p: refPoint(ep.at), shore: target?.polygon ? ring(target.polygon) : null };
            };
            const A = resolveEnd(p.from);
            const B = resolveEnd(p.to);
            if (A.p && B.p) {
              const via = p.via.map(toXY);
              const a = A.shore ? nearestOnPolyline(A.shore, via[0] ?? B.p) : A.p;
              const b = B.shore ? nearestOnPolyline(B.shore, via[via.length - 1] ?? A.p) : B.p;
              out.polyline = finishCourse(e, [a, ...via, b]);
              if (chain.includes("coastline")) coastCurves.push({ raw: [a, ...via, b], finished: out.polyline });
            }
            break;
          }
          case "along": {
            if (!out.polyline) {
              const whole = lineAspect(p.ref, p.face, null, null, e.line);
              if (whole) out.polyline = whole;
              break;
            }
            if (out.polyline) {
              const first = out.polyline[0];
              const last = out.polyline[out.polyline.length - 1];
              let guide = lineAspect(p.ref, p.face, first, last, e.line);
              if (guide) {
                if (waterVector) {
                  const vec = waterVector;
                  guide = guide.map((pt) => ({ x: pt.x - vec.x * 4, y: pt.y - vec.y * 4 }));
                }
                out.polyline = [first, ...guide, last];
              }
            } else {
              const line = lineAspect(p.ref, p.face, null, null, e.line);
              if (line) out.polyline = line.map((pt) => ({ ...pt }));
            }
            break;
          }
        }
      }
    }
    if (onRef) {
      const line = lookup(onRef)?.polyline;
      if (line) out.point = nearestOnPolyline(line, out.point ?? centroid(line));
      else if (!out.point) {
        const base = refPoint(onRef);
        if (base) out.point = { x: base.x, y: base.y };
      }
      if (out.point && e.section !== "water" && waterVector) {
        out.point = { x: out.point.x - waterVector.x * 7, y: out.point.y - waterVector.y * 7 };
      }
    }
    return out;
  };
  const items = [];
  const chainByKey = /* @__PURE__ */ new Map();
  for (const e of model.entities) {
    const r = resolveEntity(e);
    const key = keyOf2(e);
    resolved.set(key, r);
    if (e.name) byName.set(e.name, key);
    if (r.halfPlane && e.section === "water") waterVector = COMPASS_VECTORS[r.halfPlane.compass] ?? null;
    const chain = model.chainOf(e.typeWord);
    chainByKey.set(key, chain);
    items.push({ e, r, chain });
  }
  const watercourses = items.filter((it) => it.chain.includes("river") && it.r.polyline);
  const joinRefs = /* @__PURE__ */ new Map();
  for (const it of watercourses) {
    const named = /* @__PURE__ */ new Set();
    for (const p of it.e.placements) {
      if (p.kind !== "relational") continue;
      if (p.form === "from-to") {
        for (const ep of [p.from, p.to]) if (ep.at.kind === "ref") named.add(ep.at.value);
      }
    }
    joinRefs.set(keyOf2(it.e), named);
  }
  const relatedByName = (a, b) => {
    const names = (it) => [...it.e.ids, ...it.e.name ? [it.e.name] : []];
    const aRefs = joinRefs.get(keyOf2(a.e)) ?? /* @__PURE__ */ new Set();
    const bRefs = joinRefs.get(keyOf2(b.e)) ?? /* @__PURE__ */ new Set();
    return names(b).some((n) => aRefs.has(n)) || names(a).some((n) => bRefs.has(n));
  };
  for (let i = 0; i < watercourses.length; i++) {
    for (let j = i + 1; j < watercourses.length; j++) {
      const a = watercourses[i];
      const b = watercourses[j];
      if (relatedByName(a, b)) continue;
      const hit = firstCrossing(a.r.polyline, b.r.polyline);
      if (!hit) continue;
      const label = (it) => it.e.name ?? it.e.ids[0] ?? it.e.typeWord ?? "a watercourse";
      diagnostics.push({
        severity: "warning",
        line: b.e.line,
        message: `'${label(a)}' and '${label(b)}' cross at (${Math.round(hit.x)},${Math.round(hit.y)}) without meeting \u2014 water does not flow over water; 'join' one to the other, or route them apart (spec 02 \xA77)`
      });
    }
  }
  const frontierFills = /* @__PURE__ */ new Map();
  for (const it of items) {
    if (it.r.halfPlane?.refKey && it.e.section !== "water" && it.e.archetype !== "zone") {
      frontierFills.set(it.r.halfPlane.refKey, { fill: theme.terrainFill(it.chain), zonePoly: halfPlanePolygon(it.r.halfPlane, w, h) });
    }
    if (it.r.alongSpans && it.r.polygon && it.e.archetype !== "zone") {
      for (const s of it.r.alongSpans) {
        if (!s.refKey) continue;
        const ch = chainByKey.get(s.refKey);
        if (ch && !ch.includes("coastline")) frontierFills.set(s.refKey, { fill: theme.terrainFill(it.chain), zonePoly: it.r.polygon });
      }
    }
  }
  const placer = new SideLabelPlacer({ w, h });
  if (model.doc.title) placer.block(0, 0, model.doc.title.length * 10 + 30, 34, 3);
  if (model.header.get("compass") === "on") placer.block(w - 60, 10, 55, 62, 3);
  for (const { e, r, chain } of items) {
    if (r.point) {
      const tier = tierFor(chain);
      placer.block(r.point.x - tier.r - 1, r.point.y - tier.r - 1, tier.r * 2 + 2, tier.r * 2 + 2, 2);
    }
  }
  const overridden = (e) => model.labelOverrides.some(
    (o) => o.target.form === "name" ? o.target.value === e.name : e.ids.includes(o.target.value)
  );
  const beltObstacles = /* @__PURE__ */ new Map();
  for (const { e, r } of items) {
    if (!r.polyline) continue;
    if (r.ridge) {
      const half = (r.beltW ?? 28) / 2 + 3;
      const own = [];
      let acc = 0;
      let lastAt = -Infinity;
      for (let i = 0; i < r.polyline.length; i++) {
        if (i > 0) {
          const a = r.polyline[i - 1];
          const b = r.polyline[i];
          acc += Math.hypot(b.x - a.x, b.y - a.y);
        }
        if (acc - lastAt >= half * 1.6) {
          const pt = r.polyline[i];
          const spec = [pt.x - half, pt.y - half, half * 2, half * 2];
          own.push({ spec, handle: placer.tempBlock(spec[0], spec[1], spec[2], spec[3], 0.3) });
          lastAt = acc;
        }
      }
      beltObstacles.set(keyOf2(e), own);
    } else {
      const strokeW = Number(pairOf(e.pairs, "width") ?? (model.chainOf(e.typeWord).includes("coastline") ? 1.2 : 2));
      const half = strokeW / 2 + 1;
      for (const pt of r.polyline) {
        placer.block(pt.x - half, pt.y - half, half * 2, half * 2, 0.35);
      }
    }
  }
  const nameHomes = [];
  for (const { e, r, chain } of items) {
    if (!r.polygon || !e.name || e.flags.includes("nolabel") || overridden(e) || !labelsOn(model)) continue;
    if (e.archetype === "zone") continue;
    const watery = e.section === "water" || chain.some((word) => word === "sea" || word === "water");
    if (watery && !chain.includes("lake")) continue;
    const c = r.point ?? centroid(r.polygon);
    const wpx = e.name.length * 11 * 0.58 + 8;
    nameHomes.push(placer.tempBlock(c.x - wpx / 2, c.y - 26, wpx, 42, 0.6));
  }
  const alongAt = (pts, t) => {
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    let want = total * t;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      if (want <= d && d > 0) {
        const f = want / d;
        return {
          p: { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f },
          dir: { x: (pts[i + 1].x - pts[i].x) / d, y: (pts[i + 1].y - pts[i].y) / d }
        };
      }
      want -= d;
    }
    return { p: pts[pts.length - 1], dir: { x: 1, y: 0 } };
  };
  const layers = { water: [], realms: [], areas: [], lines: [], points: [], labels: [] };
  let pathLabelCount = 0;
  const labelBuckets = [[], [], [], [], []];
  const labelJobs = [];
  const deferLabel = (priority, run) => void labelJobs.push({ priority, run });
  if (nameHomes.length) deferLabel(2.5, () => nameHomes.forEach((b) => placer.release(b)));
  const massifs = [];
  const realmInfos = [];
  const islandInfos = [];
  const borderDecls = [];
  const waterPolys = [];
  const hasWater = items.some(
    ({ e, chain }) => e.section === "water" || chain.some((word) => word === "sea" || word === "lake" || word === "water")
  );
  const landMaskId = `cd-land-${model.doc.docId}`;
  const landMask = hasWater ? `url(#${landMaskId})` : void 0;
  const shoreMaskId = (i) => `cd-shore-${model.doc.docId}-${i}`;
  const insideMaskId = (i) => `cd-inside-${model.doc.docId}-${i}`;
  const coastMaskId = `cd-coast-union-${model.doc.docId}`;
  const waterMaskId = `cd-water-${model.doc.docId}`;
  const hasIslands = model.entities.some((e) => model.chainOf(e.typeWord ?? "").includes("island"));
  for (const { e, r, chain } of items) {
    const anchor = anchorAttr(model, e);
    const title = gmTitleFor(model, e);
    const titleEl = title ? svgTitle(title) : "";
    const wordFill = theme.terrainFill(chain);
    if (chain.includes("border")) {
      borderDecls.push(e);
      continue;
    }
    if (chain.includes("note")) {
      const label = e.texts[0] ?? e.name;
      if (label && r.polyline && r.polyline.length > 1) {
        const pid = `cdnote-${model.doc.docId}-${pathLabelCount++}`;
        const lp = r.polyline;
        const d = `M${fmt(lp[0].x)} ${fmt(lp[0].y)}` + lp.slice(1).map((pt) => `L${fmt(pt.x)} ${fmt(pt.y)}`).join("");
        labelBuckets[0].push(
          `<defs><path id="${pid}" d="${d}"/></defs><text font-size="11" fill="${theme.prop(chain, "fill") ?? theme.surface("ink", "fill", INK)}" opacity="0.85" text-anchor="middle" font-family="sans-serif"><textPath href="#${pid}" startOffset="50%"><tspan dy="-4">${esc(label)}</tspan></textPath></text>`
        );
        continue;
      }
      const at = r.point ?? (r.polygon ? centroid(r.polygon) : null);
      if (label && at) {
        const span = r.polygon ? Math.max(...r.polygon.map((p) => p.x)) - Math.min(...r.polygon.map((p) => p.x)) : 0;
        const size2 = 11;
        const spacing = e.flags.includes("sprawl") && span > 0 ? Math.max(0, (span - label.length * size2 * 0.58) / Math.max(1, label.length - 1)) : void 0;
        labelBuckets[0].push(
          text(label, {
            x: at.x,
            y: at.y,
            "font-size": size2,
            "letter-spacing": spacing,
            fill: INK,
            opacity: 0.85,
            "text-anchor": "middle",
            "font-family": "sans-serif"
          })
        );
      } else if (label) {
        diagnostics.push({
          severity: "warning",
          line: e.line,
          message: `free text "${label}" has no point or area placement \u2014 this renderer draws nothing for it (spec 07 \xA72)`
        });
      }
      continue;
    }
    if (r.halfPlane) {
      const poly = halfPlanePolygon(r.halfPlane, w, h);
      const isWater = e.section === "water";
      const isZone = !isWater && e.archetype === "zone";
      if (isWater) {
        const seaFill = theme.terrainFill(["sea"]);
        waterPolys.push({ poly, name: e.name ?? void 0, fill: seaFill });
        layers.water.push(el("g", { id: anchor }, titleEl, el("polygon", { points: pointsAttr(poly), fill: seaFill })));
      } else if (isZone) {
        const realmFill = theme.prop(chain, "fill") ?? wordTint(keyOf2(e));
        layers.realms.push(el("g", { id: anchor }, titleEl, el("polygon", { points: pointsAttr(poly), fill: realmFill, opacity: 0.2 })));
        realmInfos.push({ e, key: keyOf2(e), poly, spans: [], fill: realmFill, frame: true });
      } else {
        layers.water.unshift(el("g", { id: anchor }, titleEl, el("polygon", { points: pointsAttr(poly), fill: wordFill })));
      }
      if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
        deferLabel(4, () => {
          const c = centroid(poly);
          const keyedLbl = model.labelsMode === "keyed" ? labelTextFor(model, e) : null;
          const labelText = keyedLbl ?? e.name.toUpperCase();
          const width = labelText.length * (18 * 0.58 + 6);
          const bw = Math.max(...poly.map((pt) => pt.x)) - Math.min(...poly.map((pt) => pt.x));
          const spot = placer.placeOrDrop(c.x, c.y, labelText, 18, "middle", [0, -bw / 6, bw / 6, -bw / 4, bw / 4], width, (x, y) => pip({ x, y }, poly)) ?? { x: c.x, y: placer.place(c.x, c.y, labelText, 18, "middle", width), size: 18 };
          labelBuckets[4].push(
            text(labelText, {
              x: spot.x,
              y: spot.y,
              "font-size": spot.size,
              "letter-spacing": 6,
              fill: isWater ? "#5a7a96" : INK,
              opacity: 0.55,
              "text-anchor": "middle",
              "font-family": "sans-serif"
            })
          );
        });
      }
      continue;
    }
    if (r.polygon) {
      if (e.archetype === "zone" && e.section === "water") {
        const tint = theme.terrainFill(["sea"]);
        layers.water.push(
          el(
            "g",
            { id: anchor },
            titleEl,
            el("polygon", {
              points: pointsAttr(r.polygon),
              fill: "none",
              stroke: shade(tint),
              "stroke-width": 1,
              "stroke-dasharray": "1 5",
              opacity: 0.55,
              "stroke-linejoin": "round"
            })
          )
        );
        if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
          deferLabel(4, () => {
            const c = centroid(r.polygon);
            const label = (model.labelsMode === "keyed" ? labelTextFor(model, e) : null) ?? e.name;
            const bboxW = Math.max(...r.polygon.map((q) => q.x)) - Math.min(...r.polygon.map((q) => q.y === q.y ? q.x : q.x));
            const { size: size2, spacing } = fitLabel(label, Math.max(bboxW * 0.8, 40), 10, 1);
            const width = label.length * (size2 * 0.58 + spacing);
            const cx = Math.min(Math.max(c.x, width / 2 + 10), w - width / 2 - 10);
            labelBuckets[4].push(
              text(label, {
                x: cx,
                y: placer.place(cx, c.y, label, size2, "middle", width),
                "font-size": size2,
                "letter-spacing": spacing,
                fill: "#5a7a96",
                opacity: 0.75,
                "font-style": "italic",
                "text-anchor": "middle",
                "font-family": "sans-serif"
              })
            );
          });
        }
        continue;
      }
      const landInWater = chain.includes("island");
      if (!landInWater && (e.section === "water" || chain.some((word) => word === "sea" || word === "lake" || word === "water"))) {
        const isLake = chain.includes("lake");
        const waterFill = theme.terrainFill(isLake ? ["lake"] : ["sea"]);
        const shore = r.polygon;
        waterPolys.push({ poly: shore, name: e.name ?? void 0, fill: waterFill });
        (isLake ? layers.areas : layers.water).push(
          el(
            "g",
            { id: anchor },
            titleEl,
            el("polygon", { points: pointsAttr(shore), fill: waterFill, stroke: isLake ? shade(waterFill) : void 0, "stroke-width": isLake ? 1.2 : void 0, "stroke-linejoin": "round" })
          )
        );
        if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
          const priority = isLake ? 3 : 4;
          deferLabel(priority, () => {
            const c = centroid(r.polygon);
            const keyedLbl = model.labelsMode === "keyed" ? labelTextFor(model, e) : null;
            const labelText = keyedLbl ?? e.name.toUpperCase();
            const bboxW = Math.max(...r.polygon.map((p) => p.x)) - Math.min(...r.polygon.map((p) => p.x));
            const { size: size2, spacing } = fitLabel(labelText, bboxW * 0.85, isLake ? 10 : 14, isLake ? 2 : 4);
            const width = labelText.length * (size2 * 0.58 + spacing);
            const cx = Math.min(Math.max(c.x, width / 2 + 10), w - width / 2 - 10);
            const y = placer.place(cx, c.y, labelText, size2, "middle", width);
            labelBuckets[priority].push(
              text(labelText, {
                x: cx,
                y,
                "font-size": size2,
                "letter-spacing": spacing,
                fill: "#5a7a96",
                opacity: 0.6,
                "text-anchor": "middle",
                "font-family": "sans-serif"
              })
            );
          });
        }
        continue;
      }
      if (e.archetype === "zone") {
        const realmFill = theme.prop(chain, "fill") ?? wordTint(keyOf2(e));
        layers.realms.push(
          el(
            "g",
            { id: anchor },
            titleEl,
            el("polygon", { points: pointsAttr(r.polygon), fill: realmFill, opacity: 0.2 })
          )
        );
        realmInfos.push({ e, key: keyOf2(e), poly: r.polygon, spans: r.alongSpans ?? [], fill: realmFill });
        if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
          deferLabel(4, () => {
            const c = centroid(r.polygon);
            const keyedLbl = model.labelsMode === "keyed" ? labelTextFor(model, e) : null;
            const labelText = keyedLbl ?? e.name.toUpperCase();
            const bboxW = Math.max(...r.polygon.map((p) => p.x)) - Math.min(...r.polygon.map((p) => p.x));
            const { size: size2, spacing } = fitLabel(labelText, bboxW * 0.8, 15, 5);
            const width = labelText.length * (size2 * 0.58 + spacing);
            const dxs = [0, -bboxW / 5, bboxW / 5, -bboxW / 3, bboxW / 3];
            const spot = placer.placeOrDrop(c.x, c.y, labelText, size2, "middle", dxs, width, (x, y) => pip({ x, y }, r.polygon)) ?? { x: c.x, y: placer.place(c.x, c.y, labelText, size2, "middle", width), size: size2 };
            labelBuckets[4].push(
              text(labelText, {
                x: spot.x,
                y: spot.y,
                "font-size": spot.size,
                "letter-spacing": spacing,
                fill: "#6b5d4a",
                opacity: 0.6,
                "text-anchor": "middle",
                "font-family": "sans-serif"
              })
            );
          });
        }
        continue;
      }
      if (chain.includes("mountains")) {
        const poly = r.polygon;
        const xs = poly.map((pt) => pt.x);
        const ys = poly.map((pt) => pt.y);
        const x0 = Math.min(...xs);
        const y0 = Math.min(...ys);
        const x1 = Math.max(...xs);
        const y1 = Math.max(...ys);
        const step = 24;
        const peaks = [];
        for (let gy = 0; y0 + gy * step * 0.85 <= y1; gy++) {
          for (let gx = 0; x0 + gx * step <= x1; gx++) {
            const px = x0 + (gx + gy % 2 * 0.5) * step;
            const py = y0 + gy * step * 0.85;
            if (!pip({ x: px, y: py }, poly)) continue;
            const s = (gx + gy) % 3 === 0 ? 6.5 : 5;
            peaks.push(`M${fmt(px - s)} ${fmt(py + s * 0.7)}L${fmt(px)} ${fmt(py - s)}L${fmt(px + s)} ${fmt(py + s * 0.7)}`);
          }
        }
        massifs.push({ anchor, titleEl, poly, peaks: peaks.join(""), fill: wordFill });
        if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
          deferLabel(3, () => {
            const c = r.point ?? centroid(poly);
            const lbl = labelTextFor(model, e) ?? e.name;
            const bw = x1 - x0;
            const spot = placer.placeOrDrop(c.x, c.y, lbl, 11, "middle", [0, -bw / 5, bw / 5]);
            if (!spot) return;
            labelBuckets[3].push(
              text(lbl, { x: spot.x, y: spot.y, "font-size": spot.size, fill: ink, opacity: 0.8, "text-anchor": "middle", "font-style": "italic", "font-family": "sans-serif" })
            );
          });
        }
        continue;
      }
      if (chain.includes("island")) {
        const islandIndex = islandInfos.length;
        islandInfos.push({ e, poly: r.polygon });
        const coast = theme.pathStroke(["coastline"]);
        const islandBank = theme.bank(["coastline"]);
        layers.areas.push(
          el(
            "g",
            { id: anchor },
            titleEl,
            el("polygon", { points: pointsAttr(r.polygon), fill: groundFill ?? theme.surface("paper", "fill", "#f9f5ea") }),
            el(
              "g",
              { mask: `url(#${shoreMaskId(islandIndex)})` },
              el(
                "g",
                islandBank === "both" ? {} : { mask: `url(#${insideMaskId(islandIndex)})` },
                el("polygon", {
                  points: pointsAttr(r.polygon),
                  fill: "none",
                  stroke: coast.stroke,
                  "stroke-width": islandBank === "both" ? 1.2 : 2.4,
                  "stroke-linejoin": "round"
                })
              )
            )
          )
        );
        if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
          deferLabel(3, () => {
            const c = r.point ?? centroid(r.polygon);
            const lbl = labelTextFor(model, e) ?? e.name;
            const bw = Math.max(...r.polygon.map((p) => p.x)) - Math.min(...r.polygon.map((p) => p.x));
            const spot = placer.placeOrDrop(c.x, c.y, lbl, 10, "middle", [0, -bw / 5, bw / 5]);
            if (!spot) return;
            labelBuckets[3].push(
              text(lbl, { x: spot.x, y: spot.y, "font-size": spot.size, fill: ink, opacity: 0.8, "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-style": "italic", "font-family": "sans-serif" })
            );
          });
        }
        continue;
      }
      const areaParts = [titleEl];
      const zones = r.alongSpans?.length ? null : theme.zones(chain, wordFill);
      if (zones) {
        areaParts.push(el("polygon", { points: pointsAttr(r.polygon), fill: zones.edge, stroke: shade(zones.edge), "stroke-width": 1 }));
        areaParts.push(el("polygon", { points: pointsAttr(shrinkPolygon(r.polygon, zones.width * 2)), fill: zones.core }));
      } else if (r.alongSpans?.length) {
        areaParts.push(el("polygon", { points: pointsAttr(r.polygon), fill: wordFill }));
      } else {
        areaParts.push(el("polygon", { points: pointsAttr(r.polygon), fill: wordFill, stroke: shade(wordFill), "stroke-width": 1 }));
      }
      const glyphName = theme.prop(chain, "glyph");
      if (glyphName) {
        areaParts.push(...scatterGlyphs(r.polygon, glyphName, theme, ink));
      }
      layers.areas.push(el("g", { id: anchor, mask: e.archetype === "terrain" ? landMask : void 0 }, ...areaParts));
      if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
        deferLabel(3, () => {
          const c = r.point ?? centroid(r.polygon);
          const lbl = labelTextFor(model, e) ?? e.name;
          const bw = Math.max(...r.polygon.map((p) => p.x)) - Math.min(...r.polygon.map((p) => p.x));
          const size2 = Math.min(18, Math.max(11, Math.round(bw / 16)));
          const spot = placer.placeOrDrop(c.x, c.y, lbl, size2, "middle", [0, -bw / 5, bw / 5, -bw / 3, bw / 3]);
          if (!spot) return;
          labelBuckets[3].push(
            text(lbl, { x: spot.x, y: spot.y, "font-size": spot.size, fill: ink, opacity: 0.8, "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-style": "italic", "font-family": "sans-serif" })
          );
        });
      }
      continue;
    }
    if (r.polyline) {
      if (r.ridge) {
        const beltW = r.beltW ?? 28;
        const lp = r.polyline;
        const cum = [0];
        for (let i = 1; i < lp.length; i++) cum.push(cum[i - 1] + Math.hypot(lp[i].x - lp[i - 1].x, lp[i].y - lp[i - 1].y));
        const total = cum[cum.length - 1] || 1;
        const phase = hashString(entityAnchor(e) ?? e.name ?? "ridge") % 628 / 100;
        const wAt = (t) => {
          const taper = Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.6);
          const wobble = 1 + 0.18 * Math.sin(4.3 * Math.PI * t + phase);
          return beltW * (0.18 + 0.82 * taper) * wobble;
        };
        const leftSide = [];
        const rightSide = [];
        for (let i = 0; i < lp.length; i++) {
          const prev = lp[Math.max(0, i - 1)];
          const next = lp[Math.min(lp.length - 1, i + 1)];
          const dx = next.x - prev.x;
          const dy = next.y - prev.y;
          const len = Math.hypot(dx, dy) || 1;
          const hw = wAt(cum[i] / total) / 2;
          leftSide.push({ x: lp[i].x + dy / len * hw, y: lp[i].y - dx / len * hw });
          rightSide.push({ x: lp[i].x - dy / len * hw, y: lp[i].y + dx / len * hw });
        }
        const beltPoly = [lp[0], ...leftSide, lp[lp.length - 1], ...[...rightSide].reverse()];
        const count = Math.max(2, Math.floor(total / Math.max(14, beltW * 0.55)));
        const peaks = [];
        for (let i = 0; i <= count; i++) {
          const t = i / count;
          const wLoc = wAt(t);
          const s = wLoc * (i % 3 === 1 ? 0.2 : 0.26);
          if (s < 2.5) continue;
          const { p, dir } = alongAt(lp, t);
          const side = i % 2 === 0 ? 1 : -1;
          const offAmt = (i % 3 === 0 ? 0 : wLoc * 0.18) * side;
          const px = p.x + dir.y * offAmt;
          const py = p.y - dir.x * offAmt;
          peaks.push(`M${fmt(px - s)} ${fmt(py + s * 0.7)}L${fmt(px)} ${fmt(py - s)}L${fmt(px + s)} ${fmt(py + s * 0.7)}`);
        }
        massifs.push({ anchor, titleEl, poly: beltPoly, peaks: peaks.join(""), fill: wordFill });
      } else {
        const frontier = frontierFills.get(keyOf2(e));
        if (frontier) {
          layers.lines.push(
            el(
              "g",
              { id: anchor },
              titleEl,
              el("polyline", { points: pointsAttr(r.polyline), fill: "none", stroke: shade(frontier.fill), "stroke-width": 1.7, "stroke-dasharray": "0.2 6", opacity: 0.9, "stroke-linejoin": "round", "stroke-linecap": "round" })
            )
          );
        } else {
          const stroke = theme.pathStroke(chain);
          const width = Number(pairOf(e.pairs, "width") ?? (chain.includes("coastline") ? 1.2 : 2));
          const lineParts = [titleEl];
          const oneSided = chain.includes("coastline") && theme.bank(chain) !== "both" && hasWater;
          const inkW = oneSided ? width * 2 : width;
          const edgeW = theme.edgeWidth(chain);
          if (edgeW) {
            const edgeStroke = theme.prop(chain, "stroke", { zone: "edge" }) ?? theme.prop(chain, "fill", { zone: "edge" }) ?? stroke.stroke;
            lineParts.push(
              el("polyline", {
                points: pointsAttr(r.polyline),
                fill: "none",
                stroke: edgeStroke,
                "stroke-width": inkW + 2 * edgeW,
                "stroke-linejoin": "round",
                "stroke-linecap": "round"
              })
            );
          }
          const coreStroke = theme.prop(chain, "fill", { zone: "core" }) ?? theme.prop(chain, "stroke", { zone: "core" }) ?? stroke.stroke;
          lineParts.push(
            el("polyline", {
              points: pointsAttr(r.polyline),
              fill: "none",
              stroke: coreStroke,
              "stroke-width": inkW,
              "stroke-dasharray": stroke.dash,
              "stroke-linejoin": "round",
              "stroke-linecap": "round"
            })
          );
          const isCoast = chain.includes("coastline");
          const bank = isCoast ? theme.bank(chain) : "both";
          const banked = bank !== "both" && hasWater ? [el("g", { mask: `url(#${bank === "water" ? waterMaskId : landMaskId})` }, ...lineParts)] : lineParts;
          layers.lines.push(el("g", {
            id: anchor,
            ...hasIslands && isCoast ? { mask: `url(#${coastMaskId})` } : {}
          }, ...banked));
        }
      }
      if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
        deferLabel(2, () => {
          const lbl = labelTextFor(model, e) ?? e.name;
          const isRidge = !!r.ridge;
          const ownBelt = isRidge ? beltObstacles.get(keyOf2(e)) ?? [] : [];
          for (const o of ownBelt) placer.release(o.handle);
          try {
            let lp = r.polyline;
            if (lp[0].x > lp[lp.length - 1].x) lp = [...lp].reverse();
            let pathLen = 0;
            for (let i = 0; i < lp.length - 1; i++) pathLen += Math.hypot(lp[i + 1].x - lp[i].x, lp[i + 1].y - lp[i].y);
            const bendOf = (offset, halfFrac, above) => {
              const ts = [-1, -0.5, 0, 0.5, 1].map((f) => Math.min(1, Math.max(0, offset + f * halfFrac)));
              const angs = ts.map((t) => {
                const d2 = alongAt(lp, t).dir;
                return Math.atan2(d2.y, d2.x);
              });
              let sum = 0;
              let signed = 0;
              for (let i = 1; i < angs.length; i++) {
                let dA = angs[i] - angs[i - 1];
                while (dA > Math.PI) dA -= 2 * Math.PI;
                while (dA < -Math.PI) dA += 2 * Math.PI;
                sum += Math.abs(dA);
                signed += dA;
              }
              const inside = !isRidge && (above && signed < 0 || !above && signed > 0);
              return sum * 80 + (inside ? Math.abs(signed) * 120 : 0);
            };
            const candidatesAt = (size2) => {
              const wpx = lbl.length * size2 * 0.58;
              const halfFrac = Math.min(0.45, wpx / 2 / Math.max(pathLen, 1));
              const slots = [0.5, 0.32, 0.68, 0.18, 0.82, 0.08, 0.92].map((s) => Math.min(1 - halfFrac, Math.max(halfFrac, s))).filter((s, i, arr) => arr.indexOf(s) === i);
              const out = [];
              const off = isRidge ? 0 : 9.5;
              const n = Math.max(3, Math.ceil(wpx / 12));
              for (const offset of slots) {
                for (const above of isRidge ? [true] : [true, false]) {
                  const boxAt = (t) => {
                    const { p, dir } = alongAt(lp, t);
                    const s = above ? 1 : -1;
                    return { cx: p.x + dir.y * off * s, top: p.y - dir.x * off * s - 4.5 };
                  };
                  const boxes = [];
                  for (let i = 0; i < n; i++) {
                    const t = offset - halfFrac + (i + 0.5) / n * 2 * halfFrac;
                    boxes.push(boxAt(Math.min(1, Math.max(0, t))));
                  }
                  out.push({ offset, above, size: size2, wpx, boxes, penalty: bendOf(offset, halfFrac, above) });
                }
              }
              return out;
            };
            const costOf = (c) => c.boxes.reduce((sum, b) => sum + placer.boxCost(b.cx, b.top, c.wpx / c.boxes.length, 9), 0);
            let pick = null;
            for (let size2 = 10; size2 >= 8 && !pick; size2--) {
              let best = null;
              for (const c of candidatesAt(size2)) {
                if (costOf(c) !== 0) continue;
                if (!best || c.penalty < best.penalty) best = c;
              }
              pick = best;
            }
            if (!pick) {
              const leastBad = (size2) => {
                const finalists = candidatesAt(size2);
                let best = finalists[0];
                let bestScore = Infinity;
                finalists.forEach((c, i) => {
                  const score = costOf(c) + c.penalty + i * size2;
                  if (score < bestScore) {
                    bestScore = score;
                    best = c;
                  }
                });
                return { c: best, overlap: costOf(best) };
              };
              for (let size2 = 10; size2 >= 8 && !pick; size2--) {
                const b = leastBad(size2);
                if (b.overlap <= b.c.wpx * 9 * 0.12) pick = b.c;
              }
              if (!pick) {
                const b = leastBad(8);
                if (b.overlap > b.c.wpx * 9 * 0.5) {
                  let anchor2 = null;
                  let led = null;
                  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
                    const a = alongAt(lp, f).p;
                    const attempt = placer.placeWithLeader(a.x, a.y, lbl, 10);
                    if (attempt) {
                      anchor2 = a;
                      led = attempt;
                      break;
                    }
                  }
                  if (!led || !anchor2) return;
                  const lead = theme.surface("leader", "stroke", ink);
                  labelBuckets[2].push(
                    el("line", {
                      x1: led.from.x,
                      y1: led.from.y,
                      x2: anchor2.x,
                      y2: anchor2.y,
                      stroke: lead,
                      "stroke-width": 0.6,
                      opacity: 0.55
                    }),
                    text(lbl, { x: led.x, y: led.y, "font-size": led.size, fill: ink, opacity: 0.75, "text-anchor": led.anchor, "font-style": "italic", "font-family": "sans-serif" })
                  );
                  return;
                }
                pick = b.c;
              }
            }
            if (pick.penalty >= 60) {
              const midp = alongAt(lp, 0.5).p;
              const spot = isRidge ? placer.placeOrDrop(midp.x, midp.y + 3, lbl, 10, "middle", [0, -24, 24], void 0, (x, y) => {
                const q = nearestOnPolyline(lp, { x, y });
                return Math.hypot(q.x - x, q.y - y) <= (r.beltW ?? 28) / 2;
              }) : placer.placeOrDrop(midp.x, midp.y - 14, lbl, 10, "middle");
              if (spot) {
                labelBuckets[2].push(
                  text(lbl, { x: spot.x, y: spot.y, "font-size": spot.size, fill: ink, opacity: isRidge ? 0.9 : 0.75, "font-weight": model.labelsMode === "keyed" ? "bold" : void 0, "text-anchor": "middle", "font-style": "italic", "font-family": "sans-serif" })
                );
                return;
              }
            }
            for (const b of pick.boxes) placer.claimBox(b.cx, b.top, pick.wpx / pick.boxes.length, 9);
            const pid = `cdlp-${model.doc.docId}-${pathLabelCount++}`;
            const d = `M${fmt(lp[0].x)} ${fmt(lp[0].y)}` + lp.slice(1).map((pt) => `L${fmt(pt.x)} ${fmt(pt.y)}`).join("");
            const safe = esc(lbl);
            const weight = model.labelsMode === "keyed" ? ' font-weight="bold"' : "";
            labelBuckets[2].push(
              `<path id="${pid}" d="${d}" fill="none"/><text font-size="${pick.size}" fill="${ink}" opacity="${isRidge ? 0.9 : 0.75}" font-style="italic"${weight} text-anchor="middle" font-family="sans-serif"><textPath href="#${pid}" startOffset="${fmt(pick.offset * 100)}%"><tspan dy="${fmt(isRidge ? 3.5 : pick.above ? -5 : 12)}">${safe}</tspan></textPath></text>`
            );
          } finally {
            for (const o of ownBelt) o.handle = placer.tempBlock(o.spec[0], o.spec[1], o.spec[2], o.spec[3], 0.3);
          }
        });
      }
      continue;
    }
    if (r.point && chain.includes("peak")) {
      const themed = theme.glyphFor(chain, r.point.x, r.point.y);
      const s = 11;
      const { x, y } = r.point;
      const fill = theme.terrainFill(chain);
      layers.areas.push(
        el(
          "g",
          { id: anchor },
          titleEl,
          themed ? glyphEl(themed, x, y, 1, ink) : el("path", {
            // A volcano is a truncated cone with a crater notch, so the
            // derivation reads on the map and not only in the name — the
            // complaint that motivated this was that "nothing volcanic
            // survives". A theme may still swap the whole motif.
            d: chain.includes("volcano") ? `M${fmt(x - s)} ${fmt(y + s * 0.7)}L${fmt(x - s * 0.42)} ${fmt(y - s * 0.55)}L${fmt(x - s * 0.16)} ${fmt(y - s * 0.28)}L${fmt(x + s * 0.16)} ${fmt(y - s * 0.28)}L${fmt(x + s * 0.42)} ${fmt(y - s * 0.55)}L${fmt(x + s)} ${fmt(y + s * 0.7)}Z` : `M${fmt(x - s)} ${fmt(y + s * 0.7)}L${fmt(x)} ${fmt(y - s)}L${fmt(x + s)} ${fmt(y + s * 0.7)}Z`,
            fill,
            stroke: shade(fill),
            "stroke-width": 1.2,
            "stroke-linejoin": "round"
          })
        )
      );
      if (chain.includes("volcano") && e.flags.includes("erupting")) {
        const plume = shade(theme.terrainFill(chain));
        layers.areas.push(el(
          "g",
          {},
          // A column of smoke leaving the crater, widening as it rises: three
          // lobes rather than a cloud, so it reads at map scale where a
          // detailed puff would silt up into a blob.
          el("path", {
            d: `M${fmt(x - s * 0.16)} ${fmt(y - s * 0.28)}C${fmt(x - s * 0.5)} ${fmt(y - s * 0.9)} ${fmt(x + s * 0.35)} ${fmt(y - s * 1.15)} ${fmt(x - s * 0.1)} ${fmt(y - s * 1.75)}C${fmt(x - s * 0.6)} ${fmt(y - s * 2.3)} ${fmt(x + s * 0.7)} ${fmt(y - s * 2.35)} ${fmt(x + s * 0.25)} ${fmt(y - s * 2.9)}`,
            fill: "none",
            stroke: plume,
            "stroke-width": 1.6,
            "stroke-linecap": "round",
            opacity: 0.75
          }),
          el("circle", { cx: x + s * 0.25, cy: y - s * 3.1, r: s * 0.26, fill: plume, opacity: 0.5 })
        ));
        placer.block(x - s, y - s * 3.4, s * 2, s * 2.4, 2);
      }
      placer.block(x - s, y - s, s * 2, s * 2, 2);
      if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
        deferLabel(1.2, () => {
          const lbl = labelTextFor(model, e) ?? e.name;
          const spot = placer.placeBesideOrDrop(x + s + 3, x - s - 3, y + 4, lbl, 11);
          if (!spot) return;
          labelBuckets[1].push(
            text(lbl, { x: spot.x, y: spot.y, "font-size": spot.size, fill: ink, "text-anchor": spot.anchor, "font-family": "sans-serif" })
          );
        });
      }
      continue;
    }
    if (r.point) {
      const tier = tierFor(chain);
      const glyphPath = theme.glyphFor(chain, r.point.x, r.point.y);
      layers.points.push(
        el(
          "g",
          { id: anchor },
          titleEl,
          glyphPath ? glyphEl(glyphPath, r.point.x, r.point.y, 0.7, ink) : chain.includes("capital") ? el("rect", {
            x: r.point.x - tier.r,
            y: r.point.y - tier.r,
            width: tier.r * 2,
            height: tier.r * 2,
            fill: ink,
            transform: `rotate(45 ${fmt(r.point.x)} ${fmt(r.point.y)})`
          }) : el("circle", { cx: r.point.x, cy: r.point.y, r: tier.r, fill: ink, stroke: "#fff", "stroke-width": 1 })
        )
      );
      const label = (e.name !== null ? labelTextFor(model, e) ?? e.name : null) ?? (e.typeWord === "note" ? e.texts[0] ?? null : null) ?? (hasTierGlyph(chain) ? null : e.typeWord);
      if (label && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model, e)) {
        const pt = r.point;
        deferLabel(2.2 + (24 - tier.font) / 100, () => {
          const spot = placer.placeBesideOrDrop(pt.x + tier.r + 3, pt.x - tier.r - 3, pt.y + 4, label, tier.font);
          if (!spot) {
            const led = placer.placeWithLeader(pt.x, pt.y, label, tier.font);
            if (!led) return;
            const lead = theme.surface("leader", "stroke", ink);
            labelBuckets[1].push(
              el("line", {
                x1: led.from.x,
                y1: led.from.y,
                x2: pt.x,
                y2: pt.y,
                stroke: lead,
                "stroke-width": 0.6,
                opacity: 0.55
              }),
              text(label, { x: led.x, y: led.y, "font-size": led.size, "font-weight": tier.weight, fill: ink, "text-anchor": led.anchor, "font-family": "sans-serif" })
            );
            return;
          }
          labelBuckets[1].push(
            // text-anchor is ALWAYS written: SVG's default is start, so an
            // omitted "middle" renders shifted right (the clipped Deepwatch).
            text(label, { x: spot.x, y: spot.y, "font-size": spot.size, "font-weight": tier.weight, fill: ink, "text-anchor": spot.anchor, "font-family": "sans-serif" })
          );
        });
      }
    }
  }
  const waters = waterPolys.map((body2) => body2.poly);
  if (waters.length) {
    for (const { e, poly } of islandInfos) {
      const named = e.name ? `'${e.name}'` : `the ${e.typeWord ?? "island"} on line ${e.line}`;
      if (!coversWater(poly, waters)) {
        diagnostics.push({
          severity: "warning",
          line: e.line,
          message: `${named} is an island with no water around it \u2014 its footprint lies entirely on land. An island rises above the sea that surrounds it (spec 05 \xA72)`
        });
        continue;
      }
      const { wet, at, depth } = surroundedByWater(poly, waters);
      if (wet >= 0.98) continue;
      const share = Math.max(1, Math.round((1 - wet) * 100));
      const where = at ? ` near (${round1(at.x / scale)},${round1(at.y / scale)})` : "";
      const far = depth > 0 ? `, reaching about ${round1(depth / scale)}${mapUnit} inland` : "";
      diagnostics.push({
        severity: "warning",
        line: e.line,
        message: `${named} touches the mainland along ${share}% of its shore${where}${far}, so the two are drawn as one landmass and it is no longer an island. Widen the channel, move it clear, or declare it as land rather than an island (spec 05 \xA72)`
      });
    }
  }
  for (const [i, ch] of narrowChannels(
    islandInfos.map(({ poly }) => poly),
    waterPolys.map(({ poly }) => poly),
    { width: w, height: h }
  ).entries()) {
    const across = ch.narrowest / scale;
    const trueWidth = across >= 0.1 ? `${round1(across)}${mapUnit}` : across >= 0.01 ? `${across.toFixed(2)}${mapUnit}` : `under 0.01${mapUnit}`;
    layers.lines.push(
      el(
        "g",
        { id: `cd-channel-${model.doc.docId}-${i}` },
        svgTitle(`this passage is ${trueWidth} across \u2014 drawn wider so it can be seen, and narrowing to its true width as you zoom in`),
        el("polyline", {
          points: pointsAttr(ch.spine),
          fill: "none",
          stroke: waterPolys[ch.water]?.fill ?? theme.terrainFill(["sea"]),
          "stroke-width": CHANNEL_FLOOR,
          "vector-effect": "non-scaling-stroke",
          "stroke-linecap": "round",
          "stroke-linejoin": "round"
        })
      )
    );
  }
  if (waters.length) {
    for (const { e, r, chain } of items) {
      if (!chain.includes("river") || !r.polyline || r.polyline.length < 2) continue;
      const course = e.placements.find(
        (p) => p.kind === "relational" && p.form === "from-to"
      );
      const ends = [
        { pt: r.polyline[0], spelled: course ? course.from.at.kind !== "point" || course.from.join === true : false },
        { pt: r.polyline[r.polyline.length - 1], spelled: course ? course.to.at.kind !== "point" || course.to.join === true : false }
      ];
      const body2 = ends.filter((end) => !end.spelled).flatMap((end) => waterPolys.filter((water) => pip(end.pt, water.poly)))[0];
      if (!body2) continue;
      const named = e.name ? `'${e.name}'` : `the ${e.typeWord ?? "river"} on line ${e.line}`;
      const into = body2.name ? `'${body2.name}'` : "open water";
      diagnostics.push({
        severity: "warning",
        line: e.line,
        // No coordinates in the suggestion: the endpoint is known here in
        // RENDERED units, and quoting those back at an author writing map
        // units would be worse than saying nothing.
        message: `${named} ends inside ${into} \u2014 it is drawn across the water and out the far side. Declare that end at the shore, with 'to <coastline> at (\u2026)' or 'from <coastline> at (\u2026)' (spec 05 \xA72, 02 \xA77)`
      });
    }
  }
  if (massifs.length) {
    const groups = [];
    for (const fill of [...new Set(massifs.map((m) => m.fill))]) {
      const mine = massifs.filter((m) => m.fill === fill);
      groups.push(
        el(
          "g",
          { opacity: 0.55, mask: landMask },
          ...mine.map((m) => el("g", { id: m.anchor }, m.titleEl, el("polygon", { points: pointsAttr(m.poly), fill })))
        )
      );
      groups.push(
        el("path", { d: mine.map((m) => m.peaks).join(""), fill: "none", stroke: shade(fill), "stroke-width": 1.4, opacity: 0.8, "stroke-linejoin": "round", "stroke-linecap": "round", mask: landMask })
      );
    }
    layers.lines.unshift(...groups);
  }
  if (realmInfos.length) {
    const distToBoundary = (pt, poly) => {
      let best = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq));
        best = Math.min(best, Math.hypot(a.x + t * dx - pt.x, a.y + t * dy - pt.y));
      }
      return best;
    };
    const SECTOR_OF = {
      n: 0,
      north: 0,
      ne: 1,
      northeast: 1,
      e: 2,
      east: 2,
      se: 3,
      southeast: 3,
      s: 4,
      south: 4,
      sw: 5,
      southwest: 5,
      w: 6,
      west: 6,
      nw: 7,
      northwest: 7
    };
    const edgeInfos = /* @__PURE__ */ new Map();
    for (const info of realmInfos) {
      const poly = info.poly;
      const edges = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let nrm = { x: (b.y - a.y) / len, y: -(b.x - a.x) / len };
        if (pip({ x: mid.x + nrm.x * 1.5, y: mid.y + nrm.y * 1.5 }, poly)) nrm = { x: -nrm.x, y: -nrm.y };
        let open = true;
        for (let t = 4; t <= 400; t += 4) {
          if (pip({ x: mid.x + nrm.x * t, y: mid.y + nrm.y * t }, poly)) {
            open = false;
            break;
          }
        }
        const deg = (Math.atan2(nrm.x, -nrm.y) * 180 / Math.PI + 360) % 360;
        const sector = Math.floor((deg + 22.5) % 360 / 45);
        const abuts = /* @__PURE__ */ new Set();
        for (const other of realmInfos) {
          if (other.key !== info.key && distToBoundary(mid, other.poly) < 2.5) abuts.add(other.key);
        }
        edges.push({ mid, nrm, sector, open, abuts });
      }
      edgeInfos.set(info.key, edges);
    }
    const stateOf = /* @__PURE__ */ new Map();
    for (const info of realmInfos) stateOf.set(info.key, new Array(info.poly.length).fill(null));
    const realmByWord = new Map(realmInfos.map((info) => [info.key, info]));
    const parsed = borderDecls.map((decl) => {
      const realms = decl.flags.filter((word) => realmByWord.has(word));
      const compass = decl.flags.filter((word) => SECTOR_OF[word] !== void 0);
      const inner = decl.flags.includes("inner");
      const alongRefs = decl.placements.filter((p) => p.kind === "relational" && p.form === "along").map((p) => p.ref.value);
      const state = decl.flags.find((word) => !realmByWord.has(word) && SECTOR_OF[word] === void 0 && word !== "inner") ?? "border";
      const specificity = alongRefs.length ? 3 : compass.length ? 2 : realms.length >= 2 ? 1 : 0;
      return { decl, realms, compass, inner, alongRefs, state, specificity };
    });
    parsed.sort((a, b) => a.specificity - b.specificity);
    for (const d of parsed) {
      const apply = (realmKey, pick) => {
        const edges = edgeInfos.get(realmKey);
        const states = stateOf.get(realmKey);
        if (!edges || !states) return;
        edges.forEach((edge, idx) => {
          if (pick(edge, idx)) states[idx] = { state: d.state, decl: d.decl };
        });
      };
      if (d.realms.length >= 2) {
        const [a, b] = [d.realms[0], d.realms[1]];
        apply(a, (edge) => edge.abuts.has(b));
        apply(b, (edge) => edge.abuts.has(a));
      } else if (d.realms.length === 1) {
        const key = d.realms[0];
        if (d.alongRefs.length) {
          const spans = realmByWord.get(key)?.spans ?? [];
          apply(key, (_edge, idx) => spans.some((s) => d.alongRefs.includes(s.ref) && idx >= s.start && idx < s.end));
        } else if (d.compass.length) {
          const sectors = new Set(d.compass.map((word) => SECTOR_OF[word]));
          apply(key, (edge) => sectors.has(edge.sector) && (d.inner ? !edge.open : edge.open));
        } else {
          apply(key, (edge) => edge.abuts.size === 0);
        }
      }
    }
    for (const info of realmInfos) {
      const states = stateOf.get(info.key);
      const poly = info.poly;
      const n = poly.length;
      let i = 0;
      while (i < n) {
        const current = states[i];
        let j = i;
        while (j + 1 < n && states[j + 1]?.state === current?.state && states[j + 1]?.decl === current?.decl) j++;
        const pts = poly.slice(i, j + 2 > n ? n : j + 2);
        if (j + 2 > n) pts.push(poly[0]);
        if (current) {
          const stateFill = theme.terrainFill([current.state]);
          const stroke = shade(stateFill);
          const title = gmTitleFor(model, current.decl);
          layers.lines.push(
            el(
              "g",
              {},
              title ? svgTitle(title) : "",
              el("polyline", { points: pointsAttr(pts), fill: "none", stroke: stateFill, "stroke-width": 7, opacity: 0.25, "stroke-linejoin": "round", "stroke-linecap": "round" }),
              el("polyline", { points: pointsAttr(pts), fill: "none", stroke, "stroke-width": 1.6, "stroke-dasharray": "9 4 2 4", opacity: 0.9, "stroke-linejoin": "round", "stroke-linecap": "round" })
            )
          );
        } else if (!info.frame) {
          layers.realms.push(
            el("polyline", { points: pointsAttr(pts), fill: "none", stroke: shade(info.fill), "stroke-width": 1.2, "stroke-dasharray": "9 4 2 4", "stroke-opacity": 0.55, "stroke-linejoin": "round" })
          );
        }
        i = j + 1;
      }
    }
  }
  for (const o of model.labelOverrides) {
    const key = o.target.form === "id" ? o.target.value : byName.get(o.target.value) ?? slugify(o.target.value);
    const name = o.target.form === "name" ? o.target.value : key;
    if (o.hint.kind === "sprawl" && o.hint.range.kind === "point-range") {
      const a = toXY(o.hint.range.from);
      const b = toXY(o.hint.range.to);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const spanLen = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 40);
      const upper = name.toUpperCase();
      const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
      deferLabel(0, () => {
        const sprawlText = (tx, ty, size3, spacing2) => text(upper, {
          x: tx,
          y: ty,
          "font-size": size3,
          "letter-spacing": spacing2,
          fill: "#5a7a96",
          opacity: 0.85,
          "text-anchor": "middle",
          "font-family": "sans-serif",
          transform: vertical ? `rotate(90 ${fmt(tx)} ${fmt(ty)})` : void 0
        });
        const s0 = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
        const s1 = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
        const cross = vertical ? cx : cy;
        let occ0 = Infinity;
        let occ1 = -Infinity;
        for (const it of items) {
          if (it.e.section === "water" || it.e.archetype === "zone") continue;
          const consider = (lo, hi, cLo, cHi) => {
            if (cHi < cross - 16 || cLo > cross + 16) return;
            occ0 = Math.min(occ0, lo);
            occ1 = Math.max(occ1, hi);
          };
          if (it.r.polygon) {
            const xs = it.r.polygon.map((p) => p.x);
            const ys = it.r.polygon.map((p) => p.y);
            if (vertical) consider(Math.min(...ys), Math.max(...ys), Math.min(...xs), Math.max(...xs));
            else consider(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
          } else if (it.r.point) {
            const p = it.r.point;
            if (vertical) consider(p.y - 6, p.y + 6, p.x - 6, p.x + 6);
            else consider(p.x - 6, p.x + 6, p.y - 6, p.y + 6);
          }
        }
        occ0 = Math.max(s0, occ0 - 10);
        occ1 = Math.min(s1, occ1 + 10);
        const targetPoly = resolved.get(key)?.polygon;
        let e0 = s0;
        let e1 = s1;
        if (targetPoly) {
          const vals = targetPoly.map((p) => vertical ? p.y : p.x);
          e0 = Math.min(e0, Math.max(12, Math.min(...vals)));
          e1 = Math.max(e1, Math.min((vertical ? h : w) - 12, Math.max(...vals)));
        }
        const stretches = [];
        if (occ0 <= occ1 && spanLen >= 200) {
          for (const st of [{ lo: e0, hi: occ0 }, { lo: occ1, hi: e1 }]) {
            if (st.hi - st.lo >= 60) stretches.push(st);
          }
        }
        if (stretches.length) {
          const fitLen = Math.min(...stretches.map((st) => st.hi - st.lo)) * 0.6;
          const { size: size3, spacing: spacing2 } = fitLabel(upper, fitLen, 16, 8);
          const halfL = upper.length * (size3 * 0.58 + spacing2) / 2 + 3;
          for (const st of stretches) {
            const m = (st.lo + st.hi) / 2;
            const tx = vertical ? cx : m;
            const ty = vertical ? m : cy;
            if (vertical) placer.block(tx - size3, ty - halfL, size3 * 2, halfL * 2, 3);
            else placer.block(tx - halfL, ty - size3, halfL * 2, size3 * 2, 3);
            labelBuckets[0].push(sprawlText(tx, ty, size3, spacing2));
          }
          return;
        }
        const { size: size2, spacing } = fitLabel(upper, spanLen, 16, 8);
        if (vertical) placer.block(cx - size2, cy - spanLen / 2, size2 * 2, spanLen, 3);
        else placer.block(cx - spanLen / 2, cy - size2, spanLen, size2 * 2, 3);
        labelBuckets[0].push(sprawlText(cx, cy, size2, spacing));
      });
    } else if (o.hint.kind === "at" && o.hint.target.kind === "point") {
      const p = toXY(o.hint.target);
      deferLabel(0, () => {
        placer.block(p.x - name.length * 3.2, p.y - 10, name.length * 6.4, 14, 3);
        labelBuckets[0].push(text(name, { x: p.x, y: p.y, "font-size": 11, fill: ink, "text-anchor": "middle", "font-family": "sans-serif" }));
      });
    } else if (o.hint.kind === "side") {
      const base = resolved.get(key)?.point;
      if (base) {
        const vec = COMPASS_VECTORS[o.hint.compass];
        const lx = base.x + vec.x * 16;
        const ly = base.y + vec.y * 16;
        deferLabel(0, () => {
          placer.block(lx - name.length * 3.2, ly - 10, name.length * 6.4, 14, 3);
          labelBuckets[0].push(text(name, { x: lx, y: ly, "font-size": 11, fill: ink, "text-anchor": "middle", "font-family": "sans-serif" }));
        });
      }
    }
  }
  labelJobs.sort((a, b) => a.priority - b.priority);
  for (const job of labelJobs) job.run();
  layers.labels.push(...labelBuckets[4], ...labelBuckets[3], ...labelBuckets[2], ...labelBuckets[1], ...labelBuckets[0]);
  const frame = { x: 0, y: 0, width: w, height: h };
  const maskBox = `maskUnits="userSpaceOnUse" x="0" y="0" width="${fmt(w)}" height="${fmt(h)}"`;
  const defs = [];
  if (hasWater) {
    defs.push(
      `<mask id="${landMaskId}" ${maskBox}>` + el("rect", { ...frame, fill: "#fff" }) + waterPolys.map(({ poly }) => el("polygon", { points: pointsAttr(poly), fill: "#000" })).join("") + islandInfos.map(({ poly }) => el("polygon", { points: pointsAttr(poly), fill: "#fff" })).join("") + `</mask>`
    );
  }
  if (hasWater) {
    defs.push(
      `<mask id="${waterMaskId}" ${maskBox}>` + el("rect", { ...frame, fill: "#000" }) + waterPolys.map(({ poly }) => el("polygon", { points: pointsAttr(poly), fill: "#fff" })).join("") + // Islands are LAND inside the water they sit in, so their own interiors
      // come back out: an island's border must lie on its water side too,
      // and the mask that grants that is the same one.
      islandInfos.map(({ poly }) => el("polygon", { points: pointsAttr(poly), fill: "#000" })).join("") + `</mask>`
    );
  }
  if (hasIslands) {
    islandInfos.forEach(({ poly }, i) => {
      defs.push(
        `<mask id="${insideMaskId(i)}" ${maskBox}>` + el("rect", { ...frame, fill: "#000" }) + el("polygon", { points: pointsAttr(poly), fill: "#fff" }) + `</mask>`
      );
      defs.push(
        `<mask id="${shoreMaskId(i)}" ${maskBox}>` + // No water declared anywhere: nothing to merge against, so show the
        // island whole rather than erasing it.
        (waterPolys.length ? el("rect", { ...frame, fill: "#000" }) + waterPolys.map(({ poly: poly2 }) => el("polygon", { points: pointsAttr(poly2), fill: "#fff" })).join("") + // Every OTHER island, not this one: an island's own interior must
        // not eat its own stroke, or every shore comes out half-width.
        islandInfos.filter((__, j) => j !== i).map(({ poly: poly2 }) => el("polygon", { points: pointsAttr(poly2), fill: "#000" })).join("") : el("rect", { ...frame, fill: "#fff" })) + `</mask>`
      );
    });
    defs.push(
      `<mask id="${coastMaskId}" ${maskBox}>` + el("rect", { ...frame, fill: "#fff" }) + islandInfos.map(({ poly }) => el("polygon", { points: pointsAttr(poly), fill: "#000" })).join("") + `</mask>`
    );
  }
  if (defs.length) body.push(`<defs>${defs.join("")}</defs>`);
  body.push(...layers.water, ...layers.realms, ...layers.areas, ...layers.lines, ...layers.points, ...layers.labels);
}
function organicOutline(pts, seed) {
  const random = rng(seed);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const extent = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const cap = extent * 0.15;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < QUANTUM) continue;
    const nx = -dy / len;
    const ny = dx / len;
    for (const t of [0.34, 0.68]) {
      const amp = (random() - 0.5) * Math.min(len * 0.22, cap);
      out.push({ x: a.x + dx * t + nx * amp, y: a.y + dy * t + ny * amp });
    }
  }
  return catmullRom(out, 5, true);
}
function firstCrossing(a, b) {
  const NEAR = 1.5;
  const ends = [a[0], a[a.length - 1], b[0], b[b.length - 1]];
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const hit = segmentIntersection(a[i - 1], a[i], b[j - 1], b[j]);
      if (!hit) continue;
      if (ends.some((e) => Math.hypot(e.x - hit.x, e.y - hit.y) <= NEAR)) continue;
      return hit;
    }
  }
  return null;
}
function segmentIntersection(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}
function fitLabel(textStr, maxPx, baseSize, baseSpacing) {
  const perChar = maxPx / textStr.length;
  for (let size = baseSize; size > 8; size--) {
    const natural = baseSpacing * size / baseSize;
    if (textStr.length * (size * 0.58 + natural) <= maxPx) return { size, spacing: natural };
    const needed = perChar - size * 0.58;
    if (needed >= 0.5) return { size, spacing: needed };
  }
  return { size: 8, spacing: Math.max(0.5, perChar - 8 * 0.58) };
}
function coversWater(poly, waters) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const STEPS = 12;
  const inside = [];
  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      const p = { x: x0 + (x1 - x0) * i / STEPS, y: y0 + (y1 - y0) * j / STEPS };
      if (pip(p, poly)) inside.push(p);
    }
  }
  const probes = inside.length ? inside : [...poly, centroid(poly)];
  return probes.some((p) => waters.some((water) => pip(p, water)));
}
function surroundedByWater(poly, waters) {
  if (poly.length < 3) return { wet: 1, at: null, depth: 0 };
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const step = Math.max(QUANTUM, diag * 0.01);
  const dry = [];
  let wet = 0;
  let total = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let n = { x: -dy / len, y: dx / len };
    if (pip({ x: mid.x + n.x * step, y: mid.y + n.y * step }, poly)) n = { x: -n.x, y: -n.y };
    const probe = { x: mid.x + n.x * step, y: mid.y + n.y * step };
    total++;
    if (waters.some((water) => pip(probe, water))) wet++;
    else dry.push(probe);
  }
  if (total === 0) return { wet: 1, at: null, depth: 0 };
  let at = null;
  let depth = 0;
  for (const p of dry) {
    let best = Infinity;
    for (const water of waters) {
      for (let i = 0; i < water.length; i++) {
        const a = water[i];
        const b = water[(i + 1) % water.length];
        const q = nearestOnSegment(a, b, p);
        best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
      }
    }
    if (Number.isFinite(best) && best >= depth) {
      depth = best;
      at = p;
    }
  }
  return { wet: wet / total, at, depth };
}
function nearestOnSegment(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return a;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}
function halfPlanePolygon(hp, w, h) {
  const line = hp.of;
  const first = line[0];
  const last = line[line.length - 1];
  const c = hp.compass;
  if ((c.includes("n") || c.includes("s")) && !c.includes("e") && !c.includes("w")) {
    const edgeY = c.includes("n") ? 0 : h;
    const ltr = first.x <= last.x;
    const x0 = ltr ? 0 : w;
    const x1 = ltr ? w : 0;
    return [{ x: x0, y: first.y }, ...line, { x: x1, y: last.y }, { x: x1, y: edgeY }, { x: x0, y: edgeY }];
  }
  const edgeX = c.includes("w") ? 0 : w;
  const ttb = first.y <= last.y;
  const y0 = ttb ? 0 : h;
  const y1 = ttb ? h : 0;
  return [{ x: first.x, y: y0 }, ...line, { x: last.x, y: y1 }, { x: edgeX, y: y1 }, { x: edgeX, y: y0 }];
}
function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}
function shade(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const dim = (v) => Math.max(0, Math.round(v * 0.8));
  return `#${(dim(n >> 16 & 255) << 16 | dim(n >> 8 & 255) << 8 | dim(n & 255)).toString(16).padStart(6, "0")}`;
}
function glyphEl(pathData, x, y, scale, ink) {
  return `<path d="${pathData}" transform="translate(${fmt(x)} ${fmt(y)}) scale(${fmt(scale)})" fill="none" stroke="${ink}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`;
}
function shrinkPolygon(pts, by) {
  const c = centroid(pts);
  return pts.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.max(0.1, (d - by) / d);
    return { x: c.x + dx * k, y: c.y + dy * k };
  });
}
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function scatterGlyphs(poly, glyphValue, theme, ink) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const out = [];
  const spacing = 30;
  for (let gy = Math.ceil(Math.min(...ys) / spacing) * spacing; gy < Math.max(...ys); gy += spacing) {
    for (let gx = Math.ceil(Math.min(...xs) / spacing) * spacing; gx < Math.max(...xs); gx += spacing) {
      let h = 2166136261;
      for (const n of [gx, gy]) {
        h ^= n;
        h = Math.imul(h, 16777619);
      }
      const jx = gx + (h >>> 3) % 13 - 6;
      const jy = gy + (h >>> 7) % 13 - 6;
      const p = { x: jx, y: jy };
      if (!pointInPolygon(p, poly)) continue;
      const chosen = theme.pickVariant(glyphValue, jx, jy);
      const path = theme.glyphs[chosen];
      if (path) out.push(glyphEl(path, jx, jy, 0.55, ink));
    }
  }
  return out;
}
function tangentAngle(controls, at) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < controls.length; i++) {
    const a = controls[i];
    const b = controls[i + 1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(mid.x - at.x, mid.y - at.y);
    if (d < bestD) {
      bestD = d;
      best = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return best;
}

// packages/render-svg/src/provenance.ts
var NOTICE = "generated by chartdown - do not hand-edit";
var MARKER_RE = /<metadata data-chartdown-source="([^"]*)" data-chartdown-doc="([^"]*)" data-chartdown-mode="([^"]*)" data-chartdown-output="([^"]*)">[^<]*<\/metadata>/;
var unesc = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
function stampProvenance(svg, p) {
  const marker = `<metadata data-chartdown-source="${esc(p.source)}" data-chartdown-doc="${esc(p.docId)}" data-chartdown-mode="${esc(p.mode)}" data-chartdown-output="${esc(p.output)}">${NOTICE}</metadata>`;
  const cleared = svg.replace(MARKER_RE, "");
  return cleared.replace(/^(<svg[^>]*>)/, `$1${marker}`);
}
function readProvenance(svg) {
  const m = MARKER_RE.exec(svg);
  return m ? { source: unesc(m[1]), docId: unesc(m[2]), mode: unesc(m[3]), output: unesc(m[4]) } : null;
}

// packages/render-svg/src/index.ts
var OVERVIEW_WIDTH = 820;
var REFERENCE_WIDTH = 1640;
function render(doc, options = {}) {
  const mode = options.mode ?? "player";
  const diagnostics = [];
  const theme = Theme.resolve(options.theme, diagnostics);
  const model = buildModel(doc, mode, theme, diagnostics);
  const body = [];
  let w = 860;
  let h = 620;
  if (doc.mapType === "battlemap") {
    const frame = battlemapFrame(model);
    const levels = doc.levels.length > 0 ? doc.levels : [doc.defaultLevel];
    const selected = options.level !== void 0 ? levels.filter((l) => l === options.level) : levels;
    const panelLevels = selected.length > 0 ? selected : levels;
    if (levels.length > 1) warnFlooredOpenStructures(model, levels, diagnostics);
    const GAP = 18;
    const band = titleBand(doc, model.header);
    w = frame.w;
    h = panelLevels.length * frame.h + (panelLevels.length - 1) * GAP + band;
    body.push(el("rect", { x: 0, y: 0, width: w, height: h, fill: theme.surface("paper", "fill", PAPER) }));
    panelLevels.forEach((level, index) => {
      const panelModel = { ...model, entities: model.entities.filter((e) => e.level === level) };
      const panelBody = [];
      renderBattlemap(panelModel, panelBody, frame, diagnostics, { level, allEntities: model.entities, levels });
      if (panelLevels.length > 1) {
        panelBody.push(
          text(`\u2014 ${level} \u2014`, { x: frame.w - 14, y: frame.h - 8, "font-size": 11, "font-style": "italic", fill: INK, "text-anchor": "end", "font-family": "sans-serif" })
        );
      }
      body.push(`<g transform="translate(0 ${fmt(band + index * (frame.h + GAP))})">${panelBody.join("")}</g>`);
    });
  } else if (doc.mapType === "hexcrawl") {
    const frame = hexFrame(model);
    w = frame.w;
    h = frame.h;
    body.push(el("rect", { x: 0, y: 0, width: w, height: h, fill: theme.surface("paper", "fill", PAPER) }));
    renderHexcrawl(model, body);
  } else {
    const extent = /^(\d+)x(\d+)([a-z]*)$/.exec(model.header.get("extent") ?? "800x600");
    const unitsW = Number(extent?.[1] ?? 800);
    const unitsH = Number(extent?.[2] ?? 600);
    const canvasW = model.header.get("detail") === "reference" ? REFERENCE_WIDTH : OVERVIEW_WIDTH;
    const scale = canvasW / unitsW;
    w = canvasW;
    h = unitsH * scale;
    body.push(el("rect", { x: 0, y: 0, width: w, height: h, fill: theme.surface("paper", "fill", PAPER) }));
    renderRegion(model, body, { w, h, scale }, diagnostics);
  }
  if (model.header.get("legend") === "on" || model.labelsMode === "keyed") {
    const legend = buildLegend(model, w);
    if (legend.height > 0) {
      const band = el("rect", { x: 0, y: 0, width: w, height: legend.height, fill: theme.surface("paper", "fill", PAPER) });
      body.push(`<g transform="translate(0 ${fmt(h)})">${band}${legend.svg}</g>`);
      h += legend.height;
    }
  }
  if (doc.title) {
    body.push(text(doc.title, { x: 14, y: 22, "font-size": 16, "font-weight": "bold", fill: INK, "font-family": "sans-serif" }));
  }
  if (model.header.get("compass") === "on") {
    const cx = w - 34;
    const cy = 40;
    body.push(
      el(
        "g",
        {},
        el("circle", { cx, cy, r: 14, fill: "none", stroke: INK, "stroke-width": 1 }),
        el("polygon", { points: `${fmt(cx)},${fmt(cy - 11)} ${fmt(cx - 4)},${fmt(cy + 6)} ${fmt(cx + 4)},${fmt(cy + 6)}`, fill: INK }),
        text("N", { x: cx, y: cy - 17, "font-size": 9, fill: INK, "text-anchor": "middle", "font-family": "sans-serif" })
      )
    );
  }
  if (model.header.get("scale-bar") === "on") {
    const extent = /^(\d+)x(\d+)([a-z]*)$/.exec(model.header.get("extent") ?? "");
    if (extent) {
      const unitsW = Number(extent[1]);
      const unit = extent[3] || "";
      const barUnits = Math.max(10, Math.round(unitsW / 8 / 10) * 10);
      const barPx = barUnits / unitsW * w;
      const y = h - 16;
      body.push(
        el(
          "g",
          {},
          el("line", { x1: 14, y1: y, x2: 14 + barPx, y2: y, stroke: INK, "stroke-width": 2 }),
          el("line", { x1: 14, y1: y - 4, x2: 14, y2: y + 4, stroke: INK, "stroke-width": 2 }),
          el("line", { x1: 14 + barPx, y1: y - 4, x2: 14 + barPx, y2: y + 4, stroke: INK, "stroke-width": 2 }),
          text(`${barUnits}${unit}`, { x: 14 + barPx / 2, y: y - 6, "font-size": 9, fill: INK, "text-anchor": "middle", "font-family": "sans-serif" })
        )
      );
    }
  }
  for (const dead of theme.deadDeclarations(themeSubjects(model))) {
    diagnostics.push({ severity: "warning", source: "theme", ...dead });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" width="${fmt(w)}" height="${fmt(h)}" font-family="sans-serif">` + body.join("") + `</svg>`;
  return { svg, diagnostics };
}
function themeSubjects(model) {
  const counts = /* @__PURE__ */ new Map();
  const bump = (key) => void counts.set(key, (counts.get(key) ?? 0) + 1);
  const walk2 = (typeWord, flags, pairs) => {
    for (const word of model.chainOf(typeWord)) {
      bump(word);
      for (const zone of ["core", "edge"]) bump(`${word}.${zone}`);
      for (const flag of flags) bump(`${word}.${flag}`);
    }
    const side = pairOf(pairs, "side");
    if (side !== void 0) bump(`side.${side}`);
  };
  for (const e of model.entities) {
    walk2(e.typeWord, e.flags, e.pairs);
    for (const d of e.details) walk2(d.typeWord, d.flags, d.pairs);
  }
  return counts;
}
function cellKeys(e) {
  const keys = /* @__PURE__ */ new Set();
  const walk2 = (ps) => {
    for (const p of ps) {
      if (p.kind === "address") {
        keys.add(`${colToNumber2(p.col)}:${p.row}`);
      } else if (p.kind === "range") {
        addRange(p);
      } else if (p.kind === "shape" && p.shape === "area") {
        walk2(p.args);
      }
    }
  };
  const addRange = (r) => {
    const c1 = Math.min(colToNumber2(r.from.col), colToNumber2(r.to.col));
    const c2 = Math.max(colToNumber2(r.from.col), colToNumber2(r.to.col));
    const r1 = Math.min(r.from.row, r.to.row);
    const r2 = Math.max(r.from.row, r.to.row);
    for (let c = c1; c <= c2; c++) for (let row = r1; row <= r2; row++) keys.add(`${c}:${row}`);
  };
  walk2(e.placements);
  return keys;
}
function warnFlooredOpenStructures(model, levels, diagnostics) {
  for (const e of model.entities) {
    if (e.archetype !== "structure" || !e.flags.includes("open")) continue;
    const li = levels.indexOf(e.level ?? "");
    if (li <= 0) continue;
    const above = levels[li - 1];
    const sky = cellKeys(e);
    for (const sib of model.entities) {
      if (sib === e || sib.level !== e.level || sib.archetype !== "structure") continue;
      for (const c of cellKeys(sib)) sky.delete(c);
    }
    for (const other of model.entities) {
      if (other.level !== above) continue;
      const floors = other.archetype === "structure" || other.section === "terrain" && !model.chainOf(other.typeWord).includes("air");
      if (!floors) continue;
      const cells = cellKeys(other);
      const hit = [...sky].find((c) => cells.has(c));
      if (hit === void 0) continue;
      const [col, row] = hit.split(":").map(Number);
      const openName = e.name ?? e.ids[0] ?? e.typeWord ?? "structure";
      const floorName = other.name ?? other.ids[0] ?? other.typeWord ?? "entity";
      diagnostics.push({
        severity: "warning",
        line: e.line,
        message: `'${openName}' is open to the sky, but '${floorName}' floors it over on level ${above} (first at ${colLetters(col)}${row}) \u2014 open ground wants air above (spec 06 \xA73)`
      });
    }
  }
}
function renderSource(source, options = {}) {
  const parsed = parse(source, options.libraries ? { libraries: options.libraries } : {});
  const renderOptions = {};
  if (options.mode) renderOptions.mode = options.mode;
  if (options.theme) renderOptions.theme = options.theme;
  if (options.level !== void 0) renderOptions.level = options.level;
  const rendered2 = render(parsed.document, renderOptions);
  return { svg: rendered2.svg, document: parsed.document, diagnostics: [...parsed.diagnostics, ...rendered2.diagnostics] };
}

// packages/action/src/lib.ts
var normalizePath = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", ".obsidian", "dist"]);
var shouldSkipDir = (name) => SKIP_DIRS.has(name) || name.startsWith(".");
var isMapDocument = (source) => /^map\s*:/m.test(source);
function extractFences(markdown) {
  const out = [];
  const re = /```chartdown[^\S\r\n]*\r?\n([\s\S]*?)```/g;
  for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) out.push(m[1]);
  return out;
}
var modesFor = (mode) => mode === "both" ? ["player", "gm"] : [mode];
var outName = (base, mode) => `${base}${mode === "gm" ? "-gm" : ""}.svg`;
function renderCdFile(path, source, opts2) {
  const base = path.replace(/\.cd$/, "");
  const report = { path, errors: [], jobs: [] };
  const docId = parse(source).document.docId;
  for (const mode of modesFor(opts2.mode)) {
    const options = { mode };
    if (opts2.theme !== void 0) options.theme = opts2.theme;
    const { svg, diagnostics } = renderSource(source, options);
    for (const d of diagnostics) {
      if (d.severity === "error") report.errors.push(`${d.source === "theme" ? "theme" : path}:${d.line}: ${d.message}`);
    }
    const outPath = outName(base, mode);
    report.jobs.push({
      outPath,
      svg: stampProvenance(svg, { source: normalizePath(path), docId, mode, output: normalizePath(outPath) })
    });
  }
  return report;
}
function renderMarkdownFile(path, markdown, opts2) {
  const report = { path, errors: [], jobs: [] };
  const base = path.replace(/\.(md|markdown)$/i, "");
  const seen = /* @__PURE__ */ new Map();
  for (const source of extractFences(markdown)) {
    const docId = parse(source).document.docId;
    const n = (seen.get(docId) ?? 0) + 1;
    seen.set(docId, n);
    const suffix = n > 1 ? `-${n}` : "";
    for (const mode of modesFor(opts2.mode)) {
      const options = { mode };
      if (opts2.theme !== void 0) options.theme = opts2.theme;
      const { svg, diagnostics } = renderSource(source, options);
      for (const d of diagnostics) {
        if (d.severity === "error") report.errors.push(`${d.source === "theme" ? "theme" : `${path} (fence ${docId})`}:${d.line}: ${d.message}`);
      }
      const outPath = outName(`${base}.${docId}${suffix}`, mode);
      report.jobs.push({
        outPath,
        svg: stampProvenance(svg, { source: normalizePath(path), docId, mode, output: normalizePath(outPath) })
      });
    }
  }
  return report;
}
function findOrphans(svgs, producedPaths, sourcePaths) {
  const fold = (p) => normalizePath(p).toLowerCase();
  const produced2 = new Set([...producedPaths].map(fold));
  const sources = new Set([...sourcePaths].map(fold));
  const report = { orphans: [], suspects: [] };
  for (const f of svgs) {
    if (produced2.has(fold(f.path))) continue;
    const marker = readProvenance(f.content);
    if (marker) {
      if (fold(marker.output) === fold(f.path)) report.orphans.push(f.path);
    } else if (looksDerived(fold(f.path), sources)) {
      report.suspects.push(f.path);
    }
  }
  return report;
}
function looksDerived(foldedPath, foldedSources) {
  const base = foldedPath.replace(/\.svg$/, "").replace(/-gm$/, "");
  if (foldedSources.has(`${base}.cd`)) return true;
  const dot = base.lastIndexOf(".");
  if (dot > base.lastIndexOf("/")) {
    const mdBase = base.slice(0, dot);
    return foldedSources.has(`${mdBase}.md`) || foldedSources.has(`${mdBase}.markdown`);
  }
  return false;
}

// packages/action/src/render.ts
var env = (name, fallback) => process.env[`INPUT_${name}`]?.trim() || fallback;
var root = env("ROOT", ".");
var opts = {
  mode: ["player", "gm", "both"].includes(env("MODE", "player")) ? env("MODE", "player") : "player",
  markdown: env("MARKDOWN", "true") !== "false",
  verify: env("VERIFY", "false") === "true"
};
var clean = ["warn", "true", "false"].includes(env("CLEAN", "warn")) ? env("CLEAN", "warn") : "warn";
var themePath = env("THEME", "");
if (themePath) opts.theme = readFileSync(themePath, "utf8");
var files = [];
var svgFiles = [];
var walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!shouldSkipDir(entry)) walk(full);
    } else if (/\.cd$/.test(entry) || opts.markdown && /\.(md|markdown)$/i.test(entry)) {
      files.push(full);
    } else if (/\.svg$/i.test(entry)) {
      svgFiles.push(full);
    }
  }
};
walk(root);
var rendered = 0;
var unchanged = 0;
var errors = [];
var drift = [];
var skipped = 0;
var produced = /* @__PURE__ */ new Set();
var scannedSources = /* @__PURE__ */ new Set();
for (const path of files) {
  const content = readFileSync(path, "utf8");
  if (/\.cd$/.test(path) && !isMapDocument(content)) {
    skipped++;
    continue;
  }
  scannedSources.add(normalizePath(path));
  const report = /\.cd$/.test(path) ? renderCdFile(path, content, opts) : renderMarkdownFile(path, content, opts);
  errors.push(...report.errors);
  for (const job of report.jobs) {
    produced.add(normalizePath(job.outPath));
    const existing = existsSync(job.outPath) ? readFileSync(job.outPath, "utf8") : null;
    if (existing === job.svg) {
      unchanged++;
      continue;
    }
    if (opts.verify) {
      drift.push(job.outPath);
    } else {
      writeFileSync(job.outPath, job.svg);
      rendered++;
    }
  }
}
var deleted = 0;
var orphanDrift = [];
if (clean !== "false") {
  const candidates = svgFiles.filter((p) => !produced.has(normalizePath(p))).map((p) => ({ path: p, content: readFileSync(p, "utf8") }));
  const { orphans, suspects } = findOrphans(candidates, produced, scannedSources);
  for (const o of orphans) {
    if (opts.verify) {
      orphanDrift.push(o);
    } else if (clean === "true") {
      unlinkSync(o);
      deleted++;
      console.log(`chartdown: deleted orphaned output ${o} (its source no longer produces it)`);
    } else {
      console.warn(`chartdown: orphaned output ${o} \u2014 its source no longer produces it; set clean: true to delete, or remove it by hand`);
    }
  }
  for (const s of suspects) {
    console.warn(`chartdown: ${s} looks generated but carries no provenance marker (pre-marker output?) \u2014 never auto-deleted; remove by hand if stale`);
  }
}
console.log(
  `chartdown: ${files.length} source file(s) scanned, ${rendered} SVG(s) written, ${unchanged} up to date` + (deleted > 0 ? `, ${deleted} orphan(s) deleted` : "") + (skipped > 0 ? `, ${skipped} non-map document(s) skipped` : "")
);
if (errors.length > 0) {
  console.error(`
${errors.length} render error(s):`);
  for (const e of errors) console.error(`  ${e}`);
}
if (drift.length > 0) {
  console.error(`
${drift.length} committed SVG(s) drift from their sources (re-render and commit):`);
  for (const d of drift) console.error(`  ${d}`);
}
if (orphanDrift.length > 0) {
  console.error(`
${orphanDrift.length} orphaned output(s) \u2014 no source produces them; delete or re-render:`);
  for (const o of orphanDrift) console.error(`  ${o}`);
}
process.exit(errors.length > 0 || drift.length > 0 || orphanDrift.length > 0 ? 1 : 0);
