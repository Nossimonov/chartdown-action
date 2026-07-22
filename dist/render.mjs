// packages/action/src/render.ts
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
      const args = [];
      while (i < tokens.length) {
        const next = tokens[i];
        if (next.kind !== "chunk") break;
        const pos = parsePositional(next.text);
        if (!pos) break;
        args.push(pos);
        i++;
      }
      result.placements.push({ kind: "shape", shape: c, args });
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
      result.placements.push(
        point ? { kind: "relational", form: "on", ref, point } : at ? { kind: "relational", form: "on", ref, at } : { kind: "relational", form: "on", ref }
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
      const ref = takeRef("along");
      if (ref) result.placements.push({ kind: "relational", form: "along", ref });
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
      if (chunkText(peek()) !== "to") {
        diagnostics.push(error(line, "expected 'to' in from\u2026to placement"));
        continue;
      }
      i++;
      const to = takeEndpoint();
      if (!to) continue;
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
var ARCHETYPES = /* @__PURE__ */ new Set([
  "terrain",
  "path",
  "feature",
  "structure",
  "barrier",
  "opening",
  "token",
  "zone",
  "light"
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
border : path

; annotation (spec 07)
note : feature

; battlemap (spec 06)
building : structure states=ruined
wall : barrier states=ruined
fence : barrier sight=all
pillar : barrier
door : opening passes=closed sight=none
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
   * First facet pair for `key` along the derivation chain — vocabulary facets
   * are overridable defaults (spec 06 §2: `campfire : feature light=20ft`
   * means every campfire glows unless the entity says otherwise).
   */
  facetOf(word, key) {
    let current = this.entries.get(word);
    while (current) {
      const pair = current.pairs.find((p) => p.key === key);
      if (pair) return pair.value;
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
    if (entry) table.add(entry, diagnostics);
  }
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
var SPEC_VERSION = "0.1";
var MAP_TYPES = /* @__PURE__ */ new Set(["battlemap", "hexcrawl", "region"]);
var KNOWN_HEADER_KEYS = /* @__PURE__ */ new Set([
  "map",
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
  "level"
]);
var UNIVERSAL_SECTIONS = /* @__PURE__ */ new Set(["vocab", "gm", "labels"]);
var SECTIONS_BY_TYPE = {
  battlemap: /* @__PURE__ */ new Set(["terrain", "structures", "features", "tokens"]),
  hexcrawl: /* @__PURE__ */ new Set(["hexes", "routes", "regions"]),
  region: /* @__PURE__ */ new Set(["water", "terrain", "paths", "settlements", "features", "realms"])
};
var RESERVED_FLAGS = /* @__PURE__ */ new Set(["hidden", "nolabel", "difficult", "seen", "unexplored"]);
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
    sections: []
  };
  let i = 0;
  if (lines[i] && lines[i].text.startsWith("#")) {
    document.title = lines[i].text.replace(/^#+\s*/, "");
    i++;
  }
  let sawMap = false;
  while (i < lines.length && !lines[i].text.startsWith("[")) {
    const raw = lines[i];
    const tokens = tokenize(raw.text, raw.line, diagnostics);
    const split = splitAtColon(tokens, raw.line, diagnostics);
    i++;
    if (!split) continue;
    const keyToken = split.subject[0];
    if (split.subject.length !== 1 || keyToken?.kind !== "chunk") {
      diagnostics.push(error(raw.line, "malformed header line \u2014 expected 'key: value'"));
      continue;
    }
    const key = keyToken.text;
    const value = split.predicate.map((t) => t.kind === "chunk" ? t.text : t.kind === "string" ? `"${t.value}"` : t.kind === "pair" ? `${t.key}=${t.value}` : ":").join(" ");
    document.header.push({ key, value, line: raw.line });
    if (!sawMap) {
      if (key !== "map") {
        diagnostics.push(error(raw.line, "'map:' must be the first header line (spec 01 \xA72)"));
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
      if (value !== SPEC_VERSION) {
        diagnostics.push(warning(raw.line, `document targets spec ${value}; this parser implements ${SPEC_VERSION}`));
      }
    } else if (key === "use") {
      const lib = options.libraries?.[value];
      if (lib === void 0) {
        diagnostics.push(warning(raw.line, `library '${value}' not provided to the parser \u2014 its vocabulary is unavailable`));
      } else {
        parseVocabDocument(lib, "library", vocab, diagnostics);
      }
    } else if (key === "id") {
      document.docId = value;
    } else if (key === "levels") {
      document.levels = value.split(/\s+/).filter(Boolean);
      if (document.levels.length < 2) diagnostics.push(error(raw.line, "levels: declares at least two levels, physical order topmost first (spec 06 \xA78)"));
    } else if (key === "level") {
      document.defaultLevel = value;
    } else if (!KNOWN_HEADER_KEYS.has(key)) {
      diagnostics.push(warning(raw.line, `unknown header key '${key}'`));
    }
  }
  if (!sawMap) diagnostics.push(error(lines[0]?.line ?? 1, "missing required 'map:' header line"));
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
    const levelParam = predicate.pairs.find((p) => p.key === "level")?.value;
    const toParam = predicate.pairs.find((p) => p.key === "to")?.value;
    if (levelParam !== void 0 && !validLevel(levelParam)) {
      diags.push(error(raw.line, document.levels.length === 0 ? "level= requires a levels: declaration (spec 06 \xA78)" : `unknown level '${levelParam}' \u2014 declared levels: ${document.levels.join(" ")}`));
    }
    if (toParam !== void 0 && !validLevel(toParam)) {
      diags.push(error(raw.line, document.levels.length === 0 ? "to= requires a levels: declaration (spec 06 \xA78)" : `unknown level '${toParam}' \u2014 declared levels: ${document.levels.join(" ")}`));
    }
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
    if (split.subject[0]?.kind === "chunk" && split.subject[0].text === "note") {
      parseEntityLine(raw, tokens, into, table, vocabTable, diags, false);
      return;
    }
    if (split.subject.length !== 1) {
      diags.push(error(raw.line, "a [labels] override subject must be a single reference; free text requires the 'note' type word (spec 07 \xA72)"));
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
var THEME_PROPS = /* @__PURE__ */ new Set(["fill", "stroke", "width", "dash", "opacity", "glyph", "asset", "edge"]);
function parseThemeDocument(source, diagnostics) {
  const doc = { entries: [], glyphs: {}, uses: [] };
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
        pairs[t.key] = t.value;
      } else {
        diagnostics.push(warning(raw.line, "theme lines take only key=value properties"));
      }
    }
    doc.entries.push({ base, sub, pairs, line: raw.line });
  }
  return doc;
}

// packages/render-svg/src/util.ts
var fmt = (n) => {
  const rounded = Math.round(n * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};
var esc = (text2) => text2.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function el(name, attrs, ...children) {
  const attrText = Object.entries(attrs).filter(([, v]) => v !== void 0).map(([k, v]) => ` ${k}="${typeof v === "number" ? fmt(v) : esc(String(v))}"`).join("");
  const body = children.join("");
  return body ? `<${name}${attrText}>${body}</${name}>` : `<${name}${attrText}/>`;
}
var text = (content, attrs) => `<text${Object.entries(attrs).filter(([, v]) => v !== void 0).map(([k, v]) => ` ${k}="${typeof v === "number" ? fmt(v) : esc(String(v))}"`).join("")}>${esc(content)}</text>`;
var pointsAttr = (pts) => pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
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
function meander(points, amount, random) {
  let current = points;
  for (let round = 0; round < 2; round++) {
    const next = [];
    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i];
      const b = current[i + 1];
      next.push(a);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = (random() - 0.5) * amount * (round === 0 ? 1 : 0.5);
      next.push({ x: mx + -dy / len * off, y: my + dx / len * off });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}
function blob(center, radius, random, segments = 14) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const angle = i / segments * Math.PI * 2;
    const r = radius * (0.78 + random() * 0.4);
    pts.push({ x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r });
  }
  return pts;
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
function colToNumber(col) {
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
  x: MARGIN + (colToNumber(a.col) - 1) * CELL,
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
      add({ col: colToNumber(p.col), row: p.row });
    } else if (p.kind === "range") {
      const c1 = Math.min(colToNumber(p.from.col), colToNumber(p.to.col));
      const c2 = Math.max(colToNumber(p.from.col), colToNumber(p.to.col));
      const r1 = Math.min(p.from.row, p.to.row);
      const r2 = Math.max(p.from.row, p.to.row);
      for (let col = c1; col <= c2; col++) for (let row = r1; row <= r2; row++) add({ col, row });
    }
  }
  return cells;
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
  for (const section of doc.sections) {
    for (const entry of section.entries) {
      if (entry.kind === "vocab-entry") vocab.add(entry, scratch);
    }
  }
  const chainOf = (word) => word ? vocab.chain(word) : [];
  const facetOf = (word, key) => word ? vocab.facetOf(word, key) : void 0;
  const labelsMode = header.get("labels") === "none" ? "none" : "names";
  const resolvedNotes = /* @__PURE__ */ new Map();
  if (doc.mapType === "battlemap") {
    resolveRelativePlacements(entities, chainOf, resolvedNotes, diagnostics);
  }
  return { doc, mode, entities, hexLines, labelOverrides, gmNotes, header, seed, theme, labelsMode, chainOf, facetOf, resolvedNotes };
}
var localText = (p) => p.kind === "address" ? `${p.col}${p.row}` : p.kind === "range" ? `${p.from.col}${p.from.row}..${p.to.col}${p.to.row}` : `${p.at.col}${p.at.row}.${p.dir}`;
function footprintCells(e) {
  const cells = /* @__PURE__ */ new Set();
  for (const p of e.placements) {
    if (p.kind === "address") cells.add(`${colToNumber(p.col)}:${p.row}`);
    if (p.kind === "range") {
      const c1 = Math.min(colToNumber(p.from.col), colToNumber(p.to.col));
      const c2 = Math.max(colToNumber(p.from.col), colToNumber(p.to.col));
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
      const col = colMin + colToNumber(a.col) - 1;
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
  capital: { r: 6, font: 15, weight: "bold" },
  city: { r: 5, font: 13, weight: "bold" },
  town: { r: 4, font: 11, weight: "normal" },
  village: { r: 3, font: 10, weight: "normal" },
  hamlet: { r: 2.5, font: 9, weight: "normal" },
  settlement: { r: 3.5, font: 10, weight: "normal" }
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
  "ledge : stroke=#6b5d4a",
  "building : fill=#efe9da",
  "building.open : fill=#e3ddc2 ; unroofed interiors read as outdoor ground (spec 06 par.3)",
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
  merge(doc) {
    for (const entry of doc.entries) {
      const key = entry.sub ? `${entry.base}.${entry.sub}` : entry.base;
      this.map.set(key, { ...this.map.get(key), ...entry.pairs });
    }
    Object.assign(this.glyphs, doc.glyphs);
  }
  /**
   * Build a theme: the default document, then an optional user theme source.
   * A `use: default` inside the user theme is honored (and implicit layering
   * on top of the default applies regardless, per spec 08 §5 selection).
   */
  static resolve(userSource, diagnostics) {
    const theme = new _Theme();
    theme.merge(parseThemeDocument(DEFAULT_THEME_SOURCE, diagnostics));
    const sources = userSource === void 0 ? [] : Array.isArray(userSource) ? userSource : [userSource];
    for (const source of sources) {
      theme.merge(parseThemeDocument(source, diagnostics));
    }
    return theme;
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
        if (value !== void 0) return value;
      }
    }
    return void 0;
  }
  surface(name, key, fallback) {
    return this.map.get(name)?.[key] ?? fallback;
  }
  terrainFill(chain, ctx = {}) {
    return this.prop(chain, "fill", ctx) ?? "#d8d3c5";
  }
  pathStroke(chain) {
    const stroke = this.prop(chain, "stroke") ?? this.prop(chain, "fill") ?? "#9a917e";
    const dash = this.prop(chain, "dash")?.replace(",", " ");
    return dash ? { stroke, dash } : { stroke };
  }
  side(word) {
    return word && this.map.get(`side.${word}`)?.["fill"] || "#8a6ab5";
  }
  /** Edge-zone thickness in px, if the theme styles an edge for this chain. */
  edgeWidth(chain) {
    const styled = chain.some((word) => this.map.has(`${word}.edge`));
    if (!styled) return null;
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
var tierOf = (word) => word && TIERS[word] || { r: 3, font: 10, weight: "normal" };
var tierFor = (chain) => {
  for (const word of chain) if (TIERS[word]) return TIERS[word];
  return { r: 3, font: 10, weight: "normal" };
};
var hasTierGlyph = (chain) => chain.some((word) => Boolean(TIERS[word]));
var hasBattlemapGlyph = (chain) => chain.some((word) => BATTLEMAP_GLYPHS.has(word));

// packages/render-svg/src/walls.ts
var SIDE_NAME = { n: "north", s: "south", w: "west", e: "east" };
function collectWalls(model) {
  const windowSegs = /* @__PURE__ */ new Set();
  const doorSegs = /* @__PURE__ */ new Set();
  const portals = [];
  for (const e of model.entities) {
    if (e.archetype !== "structure") continue;
    for (const d of e.details) {
      const chain = model.chainOf(d.typeWord);
      const isWindow = chain.includes("window");
      const isDoor = !isWindow && (chain.includes("door") || chain.includes("gate"));
      if (!isWindow && !isDoor) continue;
      for (const p of d.placements) {
        if (p.kind !== "edge") continue;
        const seg = edgeSegment(p.at, p.dir);
        (isWindow ? windowSegs : doorSegs).add(segKey(seg));
        portals.push({ seg, closed: pairOf(d.pairs, "passes") !== "open" });
      }
    }
  }
  const blockers = [];
  const losWalls = [];
  const push = (seg) => {
    const key = segKey(seg);
    if (windowSegs.has(key)) return;
    blockers.push(seg);
    if (!doorSegs.has(key)) losWalls.push(seg);
  };
  for (const e of model.entities) {
    if (e.archetype === "structure") {
      const cells = structureCells(e);
      if (cells.size === 0) continue;
      const ruined = new Set(e.details.filter((d) => d.typeWord === "ruined").flatMap((d) => d.flags));
      for (const pe of perimeterEdges(cells)) {
        if (ruined.has(SIDE_NAME[pe.dir]) || ruined.has(pe.dir)) continue;
        const address = { kind: "address", col: colLetters(pe.cell.col), row: pe.cell.row };
        push(edgeSegment(address, pe.dir));
      }
    } else if (e.archetype === "barrier" && !model.chainOf(e.typeWord).includes("fence")) {
      for (const p of e.placements) {
        if (p.kind === "edge") push(edgeSegment(p.at, p.dir));
      }
    }
  }
  return { blockers, losWalls, portals };
}

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
    const titleEl = title ? el("title", {}, title) : "";
    const elevation = pairOf(e.pairs, "elevation");
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
    if (e.archetype === "barrier") {
      renderBarrier(e, layers.structures, titleEl, anchor);
      continue;
    }
    const zoneLike = e.archetype === "zone" || hasOnlyRange(e) && (e.archetype === "token" || e.gmOnly || elevation !== void 0);
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
  if (levelCtx) {
    for (const source of levelCtx.allEntities) {
      const to = pairOf(source.pairs, "to");
      if (to !== levelCtx.level || source.level === levelCtx.level) continue;
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
    ...layers.tokens,
    ...layers.labels
  );
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
      if (p.kind === "address") out.push({ col: colToNumber(p.col), row: p.row });
      else if (p.kind === "range") {
        const c1 = colToNumber(p.from.col);
        const c2 = colToNumber(p.to.col);
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
            const key = `${colToNumber(atCell.col)}:${atCell.row}`;
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
  function renderConnector(e, chain, c, to, parts, into, anchor) {
    if (!levelCtx) return;
    const currentIdx = levelCtx.levels.indexOf(levelCtx.level);
    const targetIdx = levelCtx.levels.indexOf(to);
    const up = targetIdx !== -1 && targetIdx < currentIdx;
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
    const areaParts = [];
    const pathParts = [];
    for (const p of e.placements) {
      if (p.kind === "shape" && p.shape === "area") {
        for (const arg of p.args) {
          if (arg.kind === "range") {
            const r = rangeRect(arg);
            areaParts.push(el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill }));
            if (e.flags.includes("difficult")) areaParts.push(el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: "url(#hatch)" }));
            if (e.flags.includes("drop")) areaParts.push(dropEdge(r));
          } else if (arg.kind === "address") {
            const o = cellOrigin(arg);
            areaParts.push(el("rect", { x: o.x, y: o.y, width: CELL, height: CELL, fill }));
          }
        }
      } else if (p.kind === "shape" && p.shape === "path") {
        const addresses = p.args.filter((a) => a.kind === "address");
        const pts = addresses.map(cellCenter);
        extendToFrame(pts, addresses, frame);
        const width = Number(pairOf(e.pairs, "width") ?? 1) * CELL * 0.85;
        const stroke = model.theme.pathStroke(chain);
        pathParts.push(el("polyline", { points: pointsAttr(pts), fill: "none", stroke: chain.includes("river") ? model.theme.terrainFill(["sea"]) : stroke.stroke, "stroke-width": width, "stroke-linecap": "butt", "stroke-linejoin": "round" }));
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
    for (const run of mergeEdgeRuns(perimeterEdges(cells))) {
      const ruined = ruinedSides.has(SIDE_NAME[run.dir]) || ruinedSides.has(run.dir);
      parts.push(el("line", { x1: run.x1, y1: run.y1, x2: run.x2, y2: run.y2, stroke: INK, "stroke-width": 3, "stroke-dasharray": ruined ? "5 6" : void 0, opacity: ruined ? 0.7 : 1 }));
    }
    for (const d of e.details) {
      for (const p of d.placements) {
        if (p.kind !== "edge") continue;
        const o = cellOrigin(p.at);
        const seg = p.dir === "n" ? { x1: o.x, y1: o.y, x2: o.x + CELL, y2: o.y } : p.dir === "s" ? { x1: o.x, y1: o.y + CELL, x2: o.x + CELL, y2: o.y + CELL } : p.dir === "w" ? { x1: o.x, y1: o.y, x2: o.x, y2: o.y + CELL } : { x1: o.x + CELL, y1: o.y, x2: o.x + CELL, y2: o.y + CELL };
        if (d.typeWord === "door" || d.typeWord === "gate") {
          layers.openings.push(el("line", { ...seg, stroke: "#a8763e", "stroke-width": 5 }));
        } else if (d.typeWord === "window" || d.typeWord === "arrow-slit") {
          layers.openings.push(el("line", { ...seg, stroke: "#6fa8c9", "stroke-width": 2.5 }));
        } else {
          parts.push(el("line", { ...seg, stroke: INK, "stroke-width": 3 }));
        }
      }
    }
    into.push(el("g", { id: anchor }, ...parts));
    if (e.name && !e.flags.includes("nolabel") && labelsOn(model)) {
      const at = placeRoomLabel(e.name, cells);
      layers.roomLabels.push(
        text(e.name, {
          x: at.x,
          y: at.y,
          "font-size": 10,
          fill: INK,
          opacity: 0.8,
          "text-anchor": "middle",
          "font-family": "sans-serif"
        })
      );
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
  function renderZone(e, into, labels, titleEl, anchor, elevation) {
    const range = e.placements.find((p) => p.kind === "range");
    if (!range) return;
    const r = rangeRect(range);
    const gmZone = e.gmOnly;
    const stroke = gmZone ? "#b5504a" : elevation ? "#6b5d4a" : "#4a9a6a";
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
          fill: gmZone ? "#b5504a" : elevation ? "#efe6d2" : "#4a9a6a",
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
    if (!e.name && !titleEl && e.typeWord) parts.unshift(el("title", {}, e.typeWord));
    for (const p of e.placements) {
      if (p.kind === "edge") {
        const s = edgeSegment(p.at, p.dir);
        parts.push(
          el("line", {
            x1: s.a.x,
            y1: s.a.y,
            x2: s.b.x,
            y2: s.b.y,
            stroke: isFence ? "#8a7a5c" : INK,
            "stroke-width": isFence ? 2 : 3,
            "stroke-dasharray": isFence ? "3 3" : ruined ? "5 6" : void 0,
            opacity: ruined ? 0.7 : 1,
            "stroke-linecap": "square"
          })
        );
      } else if (p.kind === "address") {
        const c = cellCenter(p);
        parts.push(el("rect", { x: c.x - 6, y: c.y - 6, width: 12, height: 12, fill: "#5a5244", stroke: INK, "stroke-width": 1 }));
      }
    }
    into.push(el("g", { id: anchor }, ...parts));
    if (e.name && !e.flags.includes("nolabel") && labelsOn(model)) {
      const first = e.placements.find((p) => p.kind === "edge" || p.kind === "address");
      if (first) {
        const at = first.kind === "edge" ? edgeSegment(first.at, first.dir).a : cellCenter(first);
        layers.labels.push(text(e.name, { x: at.x, y: at.y - 6, "font-size": 8, fill: INK, "text-anchor": "middle", "font-family": "sans-serif" }));
      }
    }
  }
  function fallbackGlyph(e, chain, c, scale, parts) {
    const has = (w) => chain.includes(w);
    if (has("campfire") || has("torch") || has("brazier") || has("lantern")) {
      parts.push(el("circle", { cx: c.x, cy: c.y, r: 5 * scale, fill: "#d9822b", stroke: "#a8541e", "stroke-width": 1.5 }));
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
      for (const [i, w] of [10, 7, 4].entries()) {
        const y = c.y + (i - 1) * 6 * scale;
        parts.push(el("line", { x1: c.x - w * scale, y1: y, x2: c.x + w * scale, y2: y, stroke: INK, "stroke-width": 2.2 }));
      }
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
      const label = addresses.length > 1 ? e.ids[idx] ?? `${e.typeWord}${idx + 1}` : e.name ?? e.ids[0] ?? e.typeWord ?? "?";
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
    const address = e.placements.find((p) => p.kind === "address");
    const range = e.placements.find((p) => p.kind === "range");
    if (!address && !range) return;
    if (!address && range) {
      const r = rangeRect(range);
      const chainR = model.chainOf(e.typeWord);
      const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      const footprintParts = [titleEl];
      if (!e.name && !titleEl && e.typeWord) footprintParts.unshift(el("title", {}, e.typeWord));
      const light2 = pairOf(e.pairs, "light") ?? model.facetOf(e.typeWord, "light");
      if (light2) {
        const radius = measureToCells(light2, model) * CELL;
        footprintParts.push(
          sightBlockers.length > 0 ? el("polygon", { points: pointsAttr(visibilityPolygon(center, radius, sightBlockers)), fill: model.theme.surface("light", "fill", "#ffd98a"), opacity: 0.22 }) : el("circle", { cx: center.x, cy: center.y, r: radius, fill: model.theme.surface("light", "fill", "#ffd98a"), opacity: 0.22 })
        );
      }
      footprintParts.push(
        el("rect", { x: r.x + 3, y: r.y + 3, width: r.w - 6, height: r.h - 6, fill: "#8f8474", stroke: INK, "stroke-width": 1.2, rx: 2 })
      );
      const themed = model.theme.glyphFor(chainR, center.x, center.y);
      if (themed) {
        const ink = model.theme.surface("ink", "fill", INK);
        const scale = Math.min(r.w, r.h) / 24 * 0.7;
        footprintParts.push(
          `<path d="${themed}" transform="translate(${fmt(center.x)} ${fmt(center.y)}) scale(${fmt(scale)})" fill="none" stroke="${ink}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`
        );
      } else {
        fallbackGlyph(e, chainR, center, Math.max(1, Math.min(r.w, r.h) / CELL) * 0.8, footprintParts);
      }
      into.push(el("g", { id: anchor }, ...footprintParts));
      if (e.name && !e.flags.includes("nolabel") && labelsOn(model)) {
        labels.push(text(e.name, { x: center.x, y: r.y + r.h + 10, "font-size": 8, fill: INK, "text-anchor": "middle", "font-family": "sans-serif" }));
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
      const ink = model.theme.surface("ink", "fill", INK);
      parts.push(
        `<path d="${themedGlyph}" transform="translate(${fmt(c.x)} ${fmt(c.y)}) scale(0.9)" fill="none" stroke="${ink}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`
      );
    } else if (fallbackGlyph(e, chain, c, 1, parts)) {
      drewFallback = true;
    } else {
      parts.push(el("rect", { x: c.x - 6, y: c.y - 6, width: 12, height: 12, fill: "#8f8474", stroke: INK, "stroke-width": 1 }));
    }
    if (!e.name && !hasBattlemapGlyph(chain) && !themedGlyph && !drewFallback && !titleEl && e.typeWord) {
      parts.unshift(el("title", {}, e.typeWord));
    }
    into.push(el("g", { id: anchor }, ...parts));
    if (e.name && !e.flags.includes("nolabel") && labelsOn(model)) {
      labels.push(text(e.name, { x: c.x, y: c.y + 20, "font-size": 8, fill: INK, "text-anchor": "middle", "font-family": "sans-serif" }));
    }
  }
}
function hasOnlyRange(e) {
  return e.placements.length > 0 && e.placements.every((p) => p.kind === "range");
}
function extendToFrame(pts, addresses, frame) {
  if (pts.length < 2 || addresses.length < 2) return;
  const fix = (index) => {
    const address = index === 0 ? addresses[0] : addresses[addresses.length - 1];
    const point = index === 0 ? pts[0] : pts[pts.length - 1];
    const col = colToNumber(address.col);
    if (address.row === 1) point.y = MARGIN;
    else if (address.row === frame.rows) point.y = MARGIN + frame.rows * CELL;
    else if (col === 1) point.x = MARGIN;
    else if (col === frame.cols) point.x = MARGIN + frame.cols * CELL;
  };
  fix(0);
  fix(-1);
}

// packages/render-svg/src/labels.ts
var LabelPlacer = class {
  boxes = [];
  /** Reserve a non-label obstacle (e.g. a glyph) so labels avoid it. */
  block(x, y, w, h) {
    this.boxes.push({ x, y, w, h });
  }
  boxFor(x, y, textStr, fontSize, anchor, widthPx) {
    const w = widthPx ?? textStr.length * fontSize * 0.58;
    const h = fontSize * 1.1;
    const bx = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
    return { x: bx, y: y - h, w, h };
  }
  tryClaim(x, y, textStr, fontSize, anchor, widthPx) {
    const box = this.boxFor(x, y, textStr, fontSize, anchor, widthPx);
    if (this.boxes.some((b) => intersects(b, box))) return false;
    this.boxes.push(box);
    return true;
  }
  claim(x, y, textStr, fontSize, anchor, widthPx) {
    this.boxes.push(this.boxFor(x, y, textStr, fontSize, anchor, widthPx));
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
  /** Returns the chosen y (x is never moved — horizontal shifts read as errors on maps). */
  place(x, y, textStr, fontSize, anchor, widthPx) {
    const h = fontSize * 1.1;
    const step = h + 2;
    const offsets = [0, step, -step, 2 * step, -2 * step, 3 * step];
    for (const dy of offsets) {
      if (this.tryClaim(x, y + dy, textStr, fontSize, anchor, widthPx)) return y + dy;
    }
    const last = offsets[offsets.length - 1];
    this.claim(x, y + last, textStr, fontSize, anchor, widthPx);
    return y + last;
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
    const candidates = [
      { x: rightX, y, anchor: "start" },
      { x: leftX, y, anchor: "end" },
      { x: rightX, y: y + step, anchor: "start" },
      { x: leftX, y: y + step, anchor: "end" },
      { x: rightX, y: y - step, anchor: "start" },
      { x: leftX, y: y - step, anchor: "end" },
      { x: rightX, y: y + 2 * step, anchor: "start" }
    ];
    for (const c of candidates) {
      if (this.tryClaim(c.x, c.y, textStr, fontSize, c.anchor)) return c;
    }
    const last = candidates[candidates.length - 1];
    this.claim(last.x, last.y, textStr, fontSize, last.anchor);
    return last;
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
    if (a.kind === "address") return [{ col: colToNumber(a.col), row: a.row }];
    const c1 = colToNumber(a.from.col);
    const c2 = colToNumber(a.to.col);
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
  const placer = new LabelPlacer();
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
      if (gmMode && cell?.gm) parts.push(el("title", {}, cell.gm));
      parts.push(el("polygon", { points: poly, fill, stroke: GRID_LINE, "stroke-width": 1 }));
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
            const anchorId = `cd-${model.doc.docId}-${slugify(cell.name)}`;
            const y = placer.place(c.x, c.y + R * 0.62, cell.name, 7.5, "middle");
            labelLayer.push(
              el(
                "g",
                { id: anchorId },
                text(cell.name, { x: c.x, y, "font-size": 7.5, fill: INK, "text-anchor": "middle", "font-family": "sans-serif" })
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
      const pts = addresses.map((a) => center(colToNumber(a.col), a.row));
      if (pts.length < 2) continue;
      const chain = model.chainOf(e.typeWord);
      const isWaterHex = (a) => {
        const cell = cells.get(keyOf(colToNumber(a.col), a.row));
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
          title ? el("title", {}, title) : "",
          el("polyline", { points: pointsAttr(pts), fill: "none", stroke: stroke.stroke, "stroke-width": chain.includes("river") ? 4 : 3, "stroke-dasharray": stroke.dash ?? (chain.includes("road") ? "8 4" : void 0), "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.85 })
        )
      );
      if (e.name && labelsOn(model)) {
        const candidates = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74].map((t) => {
          const p = arcPoint(pts, t);
          return { x: p.x, y: p.y - R * 0.55 };
        });
        const at = placer.placeAlong(candidates, e.name, 8, "middle");
        labelLayer.push(text(e.name, { x: at.x, y: at.y, "font-size": 8, fill: INK, opacity: 0.8, "font-style": "italic", "text-anchor": "middle", "font-family": "sans-serif" }));
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
        const labelText = e.name.toUpperCase();
        const width = labelText.length * (11 * 0.58 + 3);
        const y = placer.place(sx / count, minY - R * 1.35, labelText, 11, "middle", width);
        labelLayer.push(
          text(e.name.toUpperCase(), { x: sx / count, y, "font-size": 11, "letter-spacing": 3, fill: "#7a5aa0", opacity: 0.85, "text-anchor": "middle", "font-family": "sans-serif" })
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
  for (const e of model.entities) add(e.typeWord, kindFor(model, e));
  for (const hex of model.hexLines) {
    add(hex.terrain, "fill");
    for (const word of hex.contents) add(word, hasTierGlyph(model.chainOf(word)) ? "tier" : "glyph");
  }
  if (rows.length === 0) return { svg: "", height: 0 };
  const ROW_H = 18;
  const PAD = 10;
  const colWidth = 150;
  const cols = Math.max(1, Math.min(4, Math.floor((width - PAD * 2) / colWidth)));
  const perCol = Math.ceil(rows.length / cols);
  const parts = [
    el("line", { x1: PAD, y1: 0.5, x2: width - PAD, y2: 0.5, stroke: "#c9c2b0", "stroke-width": 1 })
  ];
  rows.forEach((row, i) => {
    const col = Math.floor(i / perCol);
    const x = PAD + col * colWidth;
    const y = PAD + i % perCol * ROW_H + ROW_H / 2;
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
          parts.push(el("rect", { x: x + 2, y: y - 5, width: 10, height: 10, fill: "#8f8474", stroke: INK, "stroke-width": 1 }));
        }
        break;
      }
    }
    parts.push(text(row.word, { x: x + 20, y: y + 3.5, "font-size": 9, fill: INK, "font-family": "sans-serif" }));
  });
  return { svg: parts.join(""), height: PAD * 2 + perCol * ROW_H };
}

// packages/render-svg/src/region.ts
function renderRegion(model, body, size) {
  const { w, h, scale } = size;
  const theme = model.theme;
  const ink = theme.surface("ink", "fill", INK);
  const random = rng(model.seed + 7);
  const resolved = /* @__PURE__ */ new Map();
  const byName = /* @__PURE__ */ new Map();
  let waterVector = null;
  const keyOf2 = (e) => entityAnchor(e) ?? `@anon-${e.line}`;
  const lookup = (ref) => resolved.get(ref.form === "id" ? ref.value : byName.get(ref.value) ?? slugify(ref.value));
  const toXY = (p) => ({ x: p.x * scale, y: p.y * scale });
  const refPoint = (ref) => {
    const r = lookup(ref);
    if (!r) return null;
    if (r.point) return r.point;
    if (r.polyline) return r.polyline[Math.floor(r.polyline.length / 2)];
    if (r.polygon) return centroid(r.polygon);
    return null;
  };
  const meanderAmount = (pts, chain) => {
    let length = 0;
    for (let i = 0; i < pts.length - 1; i++) length += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    const factor = chain.includes("river") ? 0.055 : chain.includes("road") ? 0.02 : 0.035;
    return Math.min(32, Math.max(6, length * factor));
  };
  const resolveEntity = (e) => {
    const chain = model.chainOf(e.typeWord);
    const out = {};
    let onRef = null;
    for (const p of e.placements) {
      if (p.kind === "point") out.point = toXY(p);
      else if (p.kind === "point-range") {
        const a = toXY(p.from);
        const b = toXY(p.to);
        out.polygon = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      } else if (p.kind === "shape") {
        const pts = p.args.filter((arg) => arg.kind === "point").map(toXY);
        if (p.shape === "blob") {
          const center = pts[0] ?? out.point ?? { x: w / 2, y: h / 2 };
          const radius = measureToNumber(pairOf(e.pairs, "size") ?? "40") / 2 * scale;
          out.polygon = blob(center, radius, random);
          out.point = center;
          out.radius = radius;
        } else if (p.shape === "area") {
          out.polygon = pts;
        } else {
          out.polyline = meander(pts, meanderAmount(pts, chain), random);
          out.ridge = p.shape === "ridge";
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
            if (r?.polyline) out.halfPlane = { compass: p.compass, of: r.polyline };
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
            if (p.point) out.point = toXY(p.point);
            break;
          case "near": {
            const target = p.target.kind === "point" ? toXY(p.target) : refPoint(p.target);
            if (target) out.point = { x: target.x + 8, y: target.y + 8 };
            break;
          }
          case "from-to": {
            const endpoint = (ep) => ep.point ? toXY(ep.point) : ep.at.kind === "point" ? toXY(ep.at) : refPoint(ep.at);
            const a = endpoint(p.from);
            const b = endpoint(p.to);
            if (a && b) {
              const raw = [a, ...p.via.map(toXY), b];
              out.polyline = meander(raw, meanderAmount(raw, chain), random);
            }
            break;
          }
          case "along": {
            const line = lookup(p.ref)?.polyline;
            if (line) {
              if (out.polyline) {
                const first = out.polyline[0];
                const last = out.polyline[out.polyline.length - 1];
                let guide = subPolylineBetween(line, first, last);
                if (waterVector) {
                  const vec = waterVector;
                  guide = guide.map((pt) => ({ x: pt.x - vec.x * 4, y: pt.y - vec.y * 4 }));
                }
                out.polyline = [first, ...guide, last];
              } else {
                out.polyline = line.map((pt) => ({ ...pt }));
              }
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
  for (const e of model.entities) {
    const r = resolveEntity(e);
    const key = keyOf2(e);
    resolved.set(key, r);
    if (e.name) byName.set(e.name, key);
    if (r.halfPlane && e.section === "water") waterVector = COMPASS_VECTORS[r.halfPlane.compass] ?? null;
    items.push({ e, r, chain: model.chainOf(e.typeWord) });
  }
  const placer = new SideLabelPlacer();
  for (const { e, r, chain } of items) {
    if (r.point) {
      const tier = tierFor(chain);
      placer.block(r.point.x - tier.r - 1, r.point.y - tier.r - 1, tier.r * 2 + 2, tier.r * 2 + 2);
    }
  }
  const overridden = (e) => model.labelOverrides.some(
    (o) => o.target.form === "name" ? o.target.value === e.name : e.ids.includes(o.target.value)
  );
  const layers = { areas: [], lines: [], points: [], labels: [] };
  for (const { e, r, chain } of items) {
    const anchor = anchorAttr(model, e);
    const title = gmTitleFor(model, e);
    const titleEl = title ? el("title", {}, title) : "";
    const wordFill = theme.terrainFill(chain);
    if (r.halfPlane) {
      const poly = halfPlanePolygon(r.halfPlane, w, h);
      const isWater = e.section === "water";
      layers.areas.push(
        el(
          "g",
          { id: anchor },
          titleEl,
          el("polygon", { points: pointsAttr(poly), fill: isWater ? theme.terrainFill(["sea"]) : wordFill, opacity: isWater ? 1 : 0.14 })
        )
      );
      if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
        const c = centroid(poly);
        const labelText = e.name.toUpperCase();
        const y = placer.place(c.x, c.y, labelText, 18, "middle", labelText.length * (18 * 0.58 + 6));
        layers.labels.push(
          text(labelText, {
            x: c.x,
            y,
            "font-size": 18,
            "letter-spacing": 6,
            fill: isWater ? "#5a7a96" : INK,
            opacity: 0.55,
            "text-anchor": "middle",
            "font-family": "sans-serif"
          })
        );
      }
      continue;
    }
    if (r.polygon) {
      const areaParts = [titleEl];
      const edgeFill = theme.prop(chain, "fill", { zone: "edge" });
      if (edgeFill) {
        const edgeW = theme.edgeWidth(chain) ?? 4;
        areaParts.push(el("polygon", { points: pointsAttr(r.polygon), fill: edgeFill, stroke: shade(edgeFill), "stroke-width": 1 }));
        areaParts.push(el("polygon", { points: pointsAttr(shrinkPolygon(r.polygon, edgeW * 2)), fill: wordFill }));
      } else {
        areaParts.push(el("polygon", { points: pointsAttr(r.polygon), fill: wordFill, stroke: shade(wordFill), "stroke-width": 1 }));
      }
      const glyphName = theme.prop(chain, "glyph");
      if (glyphName) {
        areaParts.push(...scatterGlyphs(r.polygon, glyphName, theme, ink));
      }
      layers.areas.push(el("g", { id: anchor }, ...areaParts));
      if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
        const c = r.point ?? centroid(r.polygon);
        const y = placer.place(c.x, c.y, e.name, 11, "middle");
        layers.labels.push(
          text(e.name, { x: c.x, y, "font-size": 11, fill: ink, opacity: 0.8, "text-anchor": "middle", "font-style": "italic", "font-family": "sans-serif" })
        );
      }
      continue;
    }
    if (r.polyline) {
      if (r.ridge) {
        layers.lines.push(
          el(
            "g",
            { id: anchor },
            titleEl,
            el("polyline", { points: pointsAttr(r.polyline), fill: "none", stroke: "#a99a85", "stroke-width": 14, opacity: 0.5, "stroke-linejoin": "round", "stroke-linecap": "round" }),
            el("polyline", { points: pointsAttr(r.polyline), fill: "none", stroke: "#8d8171", "stroke-width": 2.5, "stroke-linejoin": "round" })
          )
        );
      } else {
        const stroke = theme.pathStroke(chain);
        const width = Number(pairOf(e.pairs, "width") ?? 2);
        const lineParts = [titleEl];
        const edgeW = theme.edgeWidth(chain);
        if (edgeW) {
          const edgeStroke = theme.prop(chain, "stroke", { zone: "edge" }) ?? theme.prop(chain, "fill", { zone: "edge" }) ?? stroke.stroke;
          lineParts.push(
            el("polyline", {
              points: pointsAttr(r.polyline),
              fill: "none",
              stroke: edgeStroke,
              "stroke-width": width + 2 * edgeW,
              "stroke-linejoin": "round",
              "stroke-linecap": "round"
            })
          );
        }
        lineParts.push(
          el("polyline", {
            points: pointsAttr(r.polyline),
            fill: "none",
            stroke: stroke.stroke,
            "stroke-width": width,
            "stroke-dasharray": stroke.dash,
            "stroke-linejoin": "round",
            "stroke-linecap": "round"
          })
        );
        layers.lines.push(el("g", { id: anchor }, ...lineParts));
      }
      if (e.name && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model)) {
        const mid = r.polyline[Math.floor(r.polyline.length / 2)];
        const y = placer.place(mid.x + 4, mid.y - 4, e.name, 10, "start");
        layers.labels.push(
          text(e.name, { x: mid.x + 4, y, "font-size": 10, fill: ink, opacity: 0.75, "font-style": "italic", "font-family": "sans-serif" })
        );
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
      const label = e.name ?? (e.typeWord === "note" ? e.texts[0] ?? null : null) ?? (hasTierGlyph(chain) ? null : e.typeWord);
      if (label && !e.flags.includes("nolabel") && !overridden(e) && labelsOn(model, e)) {
        const spot = placer.placeBeside(r.point.x + tier.r + 3, r.point.x - tier.r - 3, r.point.y + 4, label, tier.font);
        layers.labels.push(
          text(label, { x: spot.x, y: spot.y, "font-size": tier.font, "font-weight": tier.weight, fill: ink, "text-anchor": spot.anchor === "middle" ? void 0 : spot.anchor, "font-family": "sans-serif" })
        );
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
      layers.labels.push(
        text(name.toUpperCase(), {
          x: cx,
          y: cy,
          "font-size": 16,
          "letter-spacing": 8,
          fill: "#5a7a96",
          opacity: 0.85,
          "text-anchor": "middle",
          "font-family": "sans-serif",
          transform: Math.abs(b.y - a.y) > Math.abs(b.x - a.x) ? `rotate(90 ${fmt(cx)} ${fmt(cy)})` : void 0
        })
      );
    } else if (o.hint.kind === "at" && o.hint.target.kind === "point") {
      const p = toXY(o.hint.target);
      layers.labels.push(text(name, { x: p.x, y: p.y, "font-size": 11, fill: ink, "text-anchor": "middle", "font-family": "sans-serif" }));
    } else if (o.hint.kind === "side") {
      const base = resolved.get(key)?.point;
      if (base) {
        const vec = COMPASS_VECTORS[o.hint.compass];
        layers.labels.push(text(name, { x: base.x + vec.x * 16, y: base.y + vec.y * 16, "font-size": 11, fill: ink, "text-anchor": "middle", "font-family": "sans-serif" }));
      }
    }
  }
  body.push(...layers.areas, ...layers.lines, ...layers.points, ...layers.labels);
}
function halfPlanePolygon(hp, w, h) {
  const line = hp.of;
  const first = line[0];
  const last = line[line.length - 1];
  const c = hp.compass;
  if ((c.includes("n") || c.includes("s")) && !c.includes("e") && !c.includes("w")) {
    const edgeY = c.includes("n") ? 0 : h;
    return [...line, { x: last.x, y: edgeY }, { x: first.x, y: edgeY }];
  }
  const edgeX = c.includes("w") ? 0 : w;
  return [...line, { x: edgeX, y: last.y }, { x: edgeX, y: first.y }];
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

// packages/render-svg/src/index.ts
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
    const scale = 820 / unitsW;
    w = 820;
    h = unitsH * scale;
    body.push(el("rect", { x: 0, y: 0, width: w, height: h, fill: theme.surface("paper", "fill", PAPER) }));
    renderRegion(model, body, { w, h, scale });
  }
  if (model.header.get("legend") === "on") {
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" width="${fmt(w)}" height="${fmt(h)}" font-family="sans-serif">` + body.join("") + `</svg>`;
  return { svg, diagnostics };
}
function cellKeys(e) {
  const keys = /* @__PURE__ */ new Set();
  const walk2 = (ps) => {
    for (const p of ps) {
      if (p.kind === "address") {
        keys.add(`${colToNumber(p.col)}:${p.row}`);
      } else if (p.kind === "range") {
        addRange(p);
      } else if (p.kind === "shape" && p.shape === "area") {
        walk2(p.args);
      }
    }
  };
  const addRange = (r) => {
    const c1 = Math.min(colToNumber(r.from.col), colToNumber(r.to.col));
    const c2 = Math.max(colToNumber(r.from.col), colToNumber(r.to.col));
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
  for (const mode of modesFor(opts2.mode)) {
    const options = { mode };
    if (opts2.theme !== void 0) options.theme = opts2.theme;
    const { svg, diagnostics } = renderSource(source, options);
    for (const d of diagnostics) {
      if (d.severity === "error") report.errors.push(`${path}:${d.line}: ${d.message}`);
    }
    report.jobs.push({ outPath: outName(base, mode), svg });
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
        if (d.severity === "error") report.errors.push(`${path} (fence ${docId}):${d.line}: ${d.message}`);
      }
      report.jobs.push({ outPath: outName(`${base}.${docId}${suffix}`, mode), svg });
    }
  }
  return report;
}

// packages/action/src/render.ts
var env = (name, fallback) => process.env[`INPUT_${name}`]?.trim() || fallback;
var root = env("ROOT", ".");
var opts = {
  mode: ["player", "gm", "both"].includes(env("MODE", "player")) ? env("MODE", "player") : "player",
  markdown: env("MARKDOWN", "true") !== "false",
  verify: env("VERIFY", "false") === "true"
};
var themePath = env("THEME", "");
if (themePath) opts.theme = readFileSync(themePath, "utf8");
var files = [];
var walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!shouldSkipDir(entry)) walk(full);
    } else if (/\.cd$/.test(entry) || opts.markdown && /\.(md|markdown)$/i.test(entry)) {
      files.push(full);
    }
  }
};
walk(root);
var rendered = 0;
var unchanged = 0;
var errors = [];
var drift = [];
var skipped = 0;
for (const path of files) {
  const content = readFileSync(path, "utf8");
  if (/\.cd$/.test(path) && !isMapDocument(content)) {
    skipped++;
    continue;
  }
  const report = /\.cd$/.test(path) ? renderCdFile(path, content, opts) : renderMarkdownFile(path, content, opts);
  errors.push(...report.errors);
  for (const job of report.jobs) {
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
console.log(
  `chartdown: ${files.length} source file(s) scanned, ${rendered} SVG(s) written, ${unchanged} up to date` + (skipped > 0 ? `, ${skipped} non-map document(s) skipped` : "")
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
process.exit(errors.length > 0 || drift.length > 0 ? 1 : 0);
