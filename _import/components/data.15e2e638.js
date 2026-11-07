import * as d3 from "../../_npm/d3@7.9.2/172963d6.js";
import {blockgroupFiles, linkFiles, providerFiles, shapeFiles} from "./files.4d5206cc.js";

export const SERVICES = new Map([
  ["Any mental health provider", "any"],
  ["Emergency services (crisis team or walk-in)", "emg"],
  ["Crisis intervention team", "cit"],
  ["Emergency walk-in", "wi"]
]);

export const SERVICE_TEXT = {
  any: "any mental health provider listed by SAMHSA",
  emg: "a provider with a crisis intervention team or psychiatric emergency walk-in services",
  cit: "a provider with a crisis intervention team",
  wi: "a provider with psychiatric emergency walk-in services"
};

export const SERVICE_SHORT = {any: "Any provider", emg: "Emergency services", cit: "Crisis team", wi: "Emergency walk-in"};

const EMERGENCY = new Set(["cit", "wi", "peon", "peoff"]);
export const isEmergency = (flag) => EMERGENCY.has(flag);

export function offersService(provider, service) {
  if (service === "any") return true;
  if (service === "emg") return provider.services.includes("cit") || provider.services.includes("wi");
  return provider.services.includes(service);
}

// Text columns stay text, so FIPS codes keep their leading zeros.
const TEXT = new Set(["state_fips", "county_fips", "abbr", "name", "id", "fips", "model", "factor"]);
export function typed(row) {
  const out = {};
  for (const key in row) {
    out[key] = TEXT.has(key) ? row[key] : row[key] === "" ? null : +row[key];
  }
  return out;
}

export const whole = d3.format(",d");
export const compact = (n) => (n >= 1e6 ? `${d3.format(".1f")(n / 1e6)}M` : n >= 1e4 ? `${d3.format(".0f")(n / 1e3)}K` : whole(n));
export const percent = (v) => (v == null ? "No data" : `${d3.format(".1f")(v)}%`);

export function tractLabel(id) {
  const tract = id.slice(5, 11);
  const major = String(+tract.slice(0, 4));
  const minor = tract.slice(4);
  return `Block group ${id[11]}, Tract ${minor === "00" ? major : `${major}.${minor}`}`;
}

const cache = new Map();
const once = (key, load) => {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key);
};

export const loadBlockgroups = (fips) =>
  once(`bg${fips}`, async () => {
    const rows = await blockgroupFiles[fips]().text();
    return d3.csvParse(rows, typed);
  });
export const loadProviders = (fips) => once(`pr${fips}`, () => providerFiles[fips]().json());
export const loadShapes = (fips) => once(`sh${fips}`, () => shapeFiles[fips]().json());
export const loadLinks = (county) =>
  once(`ln${county}`, async () => {
    if (!linkFiles[county]) return [];
    return d3.csvParse(await linkFiles[county]().text());
  });

// Providers reachable from a place, each with the shorter of its two drive times.
export async function providersFor(place) {
  if (!place) return {labels: {}, list: []};
  const fips = place.id.slice(0, 2);
  const {labels, providers} = await loadProviders(fips);
  if (place.level === "state") return {labels, list: providers};
  let links = await loadLinks(place.id.slice(0, 5));
  if (place.level === "blockgroup") links = links.filter((row) => row.id === place.id);
  const best = new Map();
  const add = (text, minutes) => {
    for (const pid of text ? text.split(" ") : []) {
      const key = +pid;
      if (!best.has(key) || minutes < best.get(key)) best.set(key, minutes);
    }
  };
  for (const row of links) {
    add(row.m15, 15);
    add(row.m30, 30);
  }
  const list = [];
  for (const provider of providers) {
    if (best.has(provider.pid)) list.push({...provider, m: best.get(provider.pid)});
  }
  return {labels, list};
}

// Provider websites come from a listing, so only ordinary web links become clickable.
export function safeWebsite(value) {
  if (!value) return null;
  const text = String(value).trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function downloadCsv(rows, filename) {
  const blob = new Blob([d3.csvFormat(rows)], {type: "text/csv"});
  const link = Object.assign(document.createElement("a"), {href: URL.createObjectURL(blob), download: filename});
  link.click();
  URL.revokeObjectURL(link.href);
}
