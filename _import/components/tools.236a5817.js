// Lookups the AI can ask for. They run here in the browser on the map's own data, so the AI
// only ever sees real figures, and it can look things up as many times as a question needs.
import {loadZips} from "./data.61880e46.js";

const SERVICE_KEYS = ["any", "emg", "cit", "wi"];
const SERVICE_NAME = {any: "any mental health provider", emg: "emergency services (crisis team or walk-in)", cit: "crisis intervention team", wi: "psychiatric emergency walk-in"};
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

export function createTools({states, counties, stateById, countyById, qa, regionRows, view}) {
  const stateByAbbr = new Map(states.map((d) => [d.abbr.toLowerCase(), d]));
  const stateByName = new Map(states.map((d) => [d.name.toLowerCase(), d]));

  // For each service: percent of residents within 15 and 30 minutes, and providers reachable.
  const access = (row) => Object.fromEntries(SERVICE_KEYS.map((s) => [SERVICE_NAME[s], {
    percent_within_15_min: round1(row[`${s}_15`]),
    percent_within_30_min: round1(row[`${s}_30`]),
    providers_within_15_min: row[`p_${s}_15`],
    providers_within_30_min: row[`p_${s}_30`]
  }]));
  const stateInfo = (d) => ({type: "state", id: d.state_fips, name: d.name, population: d.pop, access: access(d)});
  const countyInfo = (d) => ({type: "county", id: d.county_fips, name: `${d.name}, ${d.abbr}`, state: stateById.get(d.state_fips)?.name, population: d.pop, access: access(d)});
  const findState = (text) => {
    const t = text.trim().toLowerCase().replace(/\.$/, "");
    return stateByName.get(t) ?? stateByAbbr.get(t) ?? (t === "dc" || t === "washington dc" ? stateByAbbr.get("dc") : null);
  };

  async function find_place({query}) {
    const text = String(query ?? "").trim();
    if (!text) return {error: "Empty query."};
    const zip = text.match(/\b(\d{5})\b/)?.[1];
    if (zip) {
      const hit = (await loadZips())[zip];
      if (!hit) return {zip, error: "Not a ZIP code area in the Census list."};
      if (!hit[2]) return {zip, error: "This ZIP is outside the map, which covers the 50 states and DC."};
      return {zip, note: "Figures are for the whole county that contains this ZIP code, not the ZIP alone.", county: countyInfo(countyById.get(hit[2]))};
    }
    const state = findState(text);
    if (state) return {state: stateInfo(state)};
    // County, optionally with its state after a comma: "Cook County, IL", "cook, illinois", "Roanoke city".
    const [namePart, statePart] = text.split(",").map((s) => s.trim().toLowerCase());
    const inState = statePart ? findState(statePart) : null;
    const name = namePart.replace(/\s+(county|parish|borough|census area|municipality)$/, "");
    let matches = counties.filter((d) => {
      const n = d.name.toLowerCase();
      return (n === namePart || n.replace(/\s+(county|parish|borough|census area|municipality|city and borough)$/, "") === name) && (!inState || d.state_fips === inState.state_fips);
    });
    if (!matches.length) matches = counties.filter((d) => d.name.toLowerCase().includes(name) && (!inState || d.state_fips === inState.state_fips)).slice(0, 8);
    if (!matches.length) return {error: `No state, county or ZIP matched "${text}".`};
    if (matches.length > 1) return {note: "Several counties match. Ask which one, or pick using the state.", options: matches.slice(0, 8).map((d) => `${d.name}, ${d.abbr}`)};
    return {county: countyInfo(matches[0])};
  }

  function rank_places({level = "county", state, service = "any", minutes = 15, order = "lowest", by = "percent", limit = 5}) {
    const s = SERVICE_KEYS.includes(service) ? service : "any";
    const m = Number(minutes) === 30 ? 30 : 15;
    const key = by === "providers" ? `p_${s}_${m}` : `${s}_${m}`;
    const scope = state ? findState(String(state)) : null;
    if (state && !scope) return {error: `Unknown state "${state}".`};
    let rows = (level === "state" ? states : counties).filter((d) => d.pop > 0 && d[key] != null);
    if (level !== "state" && scope) rows = rows.filter((d) => d.state_fips === scope.state_fips);
    const sign = order === "highest" ? -1 : 1;
    rows = [...rows].sort((a, b) => sign * (a[key] - b[key]) || b.pop - a.pop);
    const n = Math.min(15, Math.max(1, Number(limit) || 5));
    const tied = order !== "highest" && by !== "providers" ? rows.filter((d) => d[key] === 0).length : 0;
    return {
      service: SERVICE_NAME[s], minutes: m, ranked_by: by === "providers" ? "providers in reach" : "percent of residents in reach", order,
      within: level === "state" ? "United States" : scope ? scope.name : "United States",
      ...(tied > n ? {note: `${tied} places are tied at 0%; the most populated are listed.`} : {}),
      places: rows.slice(0, n).map((d) => ({
        type: level === "state" ? "state" : "county",
        id: level === "state" ? d.state_fips : d.county_fips,
        name: level === "state" ? d.name : `${d.name}, ${d.abbr}`,
        value: by === "providers" ? d[key] : round1(d[key]),
        population: d.pop
      }))
    };
  }

  function national_overview() {
    return {
      united_states: Object.fromEntries(SERVICE_KEYS.map((s) => [SERVICE_NAME[s], {percent_within_15_min: round1(qa.national[`${s}_15`]), percent_within_30_min: round1(qa.national[`${s}_30`])}])),
      census_regions: regionRows.map((r) => ({region: r.region, ...Object.fromEntries(SERVICE_KEYS.map((s) => [SERVICE_NAME[s], {percent_within_15_min: round1(r[`${s}_15`]), percent_within_30_min: round1(r[`${s}_30`])}]))}))
    };
  }

  function current_view() {
    return view();
  }

  const handlers = {find_place, rank_places, national_overview, current_view};
  return {
    async run(name, args) {
      const handler = handlers[name];
      if (!handler) return {error: `Unknown tool ${name}.`};
      try {
        return await handler(args ?? {});
      } catch (error) {
        return {error: String(error?.message ?? error)};
      }
    },
    // Places mentioned in a tool result, so the chat can offer them as map buttons.
    placesIn(result) {
      const out = [];
      const add = (p) => p?.id && p?.type && out.push({label: p.name, place: {level: p.type === "state" ? "state" : "county", id: p.id}});
      add(result?.state);
      add(result?.county);
      for (const p of result?.places ?? []) add(p);
      return out;
    }
  };
}
