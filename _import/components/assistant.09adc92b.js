// A question box that looks up the figures already on this page. It runs entirely in the browser
// and follows fixed rules, so it is not an AI model and never sends questions anywhere.

const SERVICE_WORDS = [
  ["cit", /crisis|\bcit\b|危机/i],
  ["wi", /walk[\s-]?in|步入/i],
  ["emg", /emergenc|急诊|紧急/i],
  ["any", /\bany\b|\ball (providers|services)\b|所有|全部/i]
];
const SERVICE_TEXT = {any: "any mental health provider", emg: "emergency services (crisis team or walk-in)", cit: "a crisis intervention team", wi: "psychiatric emergency walk-in services"};
const REGIONS = ["Northeast", "Midwest", "South", "West"];
const REGION_ZH = {"东北": "Northeast", "中西部": "Midwest", "南部": "South", "西部": "West"};
// Common Chinese names for states, matched longest first so 西弗吉尼亚 is not read as 弗吉尼亚.
const STATE_ZH = {
  "阿拉巴马": "AL", "阿拉斯加": "AK", "亚利桑那": "AZ", "阿肯色": "AR", "加利福尼亚": "CA", "加州": "CA", "科罗拉多": "CO",
  "康涅狄格": "CT", "特拉华": "DE", "华盛顿特区": "DC", "佛罗里达": "FL", "佐治亚": "GA", "乔治亚": "GA", "夏威夷": "HI",
  "爱达荷": "ID", "伊利诺伊": "IL", "印第安纳": "IN", "艾奥瓦": "IA", "爱荷华": "IA", "堪萨斯": "KS", "肯塔基": "KY",
  "路易斯安那": "LA", "缅因": "ME", "马里兰": "MD", "马萨诸塞": "MA", "麻州": "MA", "密歇根": "MI", "明尼苏达": "MN",
  "密西西比": "MS", "密苏里": "MO", "蒙大拿": "MT", "内布拉斯加": "NE", "内华达": "NV", "新罕布什尔": "NH", "新泽西": "NJ",
  "新墨西哥": "NM", "纽约": "NY", "北卡罗来纳": "NC", "北卡": "NC", "北达科他": "ND", "俄亥俄": "OH", "俄克拉何马": "OK",
  "俄勒冈": "OR", "宾夕法尼亚": "PA", "宾州": "PA", "罗德岛": "RI", "南卡罗来纳": "SC", "南卡": "SC", "南达科他": "SD",
  "田纳西": "TN", "德克萨斯": "TX", "得克萨斯": "TX", "德州": "TX", "犹他": "UT", "佛蒙特": "VT", "弗吉尼亚": "VA",
  "华盛顿州": "WA", "西弗吉尼亚": "WV", "威斯康星": "WI", "怀俄明": "WY"
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createAssistant({states, counties, stateById, countyById, qa, regionRows}) {
  const stateNames = states.map((d) => ({...d, pattern: new RegExp(`\\b${escapeRegExp(d.name.toLowerCase())}\\b`)}));
  const stateByAbbr = new Map(states.map((d) => [d.abbr, d]));
  const countyIndex = counties.map((d) => ({...d, lower: d.name.toLowerCase()}));

  function findPlaces(question) {
    const lower = question.toLowerCase();
    let rest = lower;
    const found = {counties: [], states: [], regions: [], ambiguous: null};
    // Counties first, longest names first, so "Washington County" is not read as the state of Washington.
    const countyHits = countyIndex.filter((d) => lower.includes(d.lower)).sort((a, b) => b.lower.length - a.lower.length);
    const countyNames = [...new Set(countyHits.map((d) => d.lower))];
    for (const name of countyNames) rest = rest.split(name).join(" ");
    for (const d of stateNames) if (d.pattern.test(rest)) found.states.push(d);
    for (const match of question.matchAll(/\b([A-Z]{2})\b/g)) {
      const d = stateByAbbr.get(match[1]);
      if (d && !found.states.includes(d)) found.states.push(d);
    }
    if (/\bdc\b|district of columbia/i.test(question) && !found.states.some((d) => d.abbr === "DC")) found.states.push(stateByAbbr.get("DC"));
    let chinese = question;
    for (const name of Object.keys(STATE_ZH).sort((a, b) => b.length - a.length)) {
      if (!chinese.includes(name)) continue;
      const d = stateByAbbr.get(STATE_ZH[name]);
      if (d && !found.states.includes(d)) found.states.push(d);
      chinese = chinese.split(name).join(" ");
    }
    for (const name of countyNames) {
      let options = countyHits.filter((d) => d.lower === name);
      if (found.states.length) {
        const inState = options.filter((d) => found.states.some((s) => s.state_fips === d.state_fips));
        if (inState.length) options = inState;
      }
      if (options.length === 1) found.counties.push(options[0]);
      else found.ambiguous = options;
    }
    // A state named only as the home of a county is context, not a place asked about.
    found.states = found.states.filter((s) => !found.counties.some((c) => c.state_fips === s.state_fips));
    for (const region of REGIONS) if (new RegExp(`\\b${region.toLowerCase()}\\b`).test(lower)) found.regions.push(region);
    let regionText = question;
    for (const name of Object.keys(REGION_ZH).sort((a, b) => b.length - a.length)) {
      if (!regionText.includes(name)) continue;
      if (!found.regions.includes(REGION_ZH[name])) found.regions.push(REGION_ZH[name]);
      regionText = regionText.split(name).join(" ");
    }
    return found;
  }

  function settings(question, defaults) {
    const service = SERVICE_WORDS.find(([, pattern]) => pattern.test(question))?.[0] ?? defaults.service;
    const minutes = /\b30\b|thirty|半小时|30\s*分/i.test(question) ? 30 : /\b15\b|fifteen|15\s*分/i.test(question) ? 15 : defaults.minutes;
    return {service, minutes, metric: `${service}_${minutes}`};
  }

  const placeOf = (row, level) => level === "state"
    ? {label: row.name, place: {level: "state", id: row.state_fips}}
    : {label: `${row.name}, ${row.abbr}`, place: {level: "county", id: row.county_fips}};

  function summary(row, level, s, fmt) {
    const without = Math.max(0, row.pop_measured - row[`reach_${s.metric}`]);
    return {
      ...placeOf(row, level),
      value: `${fmt.percent(row[s.metric])} within ${s.minutes} min (15 min: ${fmt.percent(row[`${s.service}_15`])}, 30 min: ${fmt.percent(row[`${s.service}_30`])}). ${fmt.whole(row[`p_${s.metric}`])} providers in reach; ${fmt.whole(without)} of ${fmt.whole(row.pop)} people have none within ${s.minutes} min.`
    };
  }

  return function answer(question, defaults, fmt) {
    const text = question.trim();
    const s = settings(text, defaults);
    const lead = `${capitalize(SERVICE_TEXT[s.service])}, within ${s.minutes} minutes.`;
    if (!text || /^(help|\?|hi|hello)$|what can|how do i|怎么用|帮助/i.test(text)) return help();

    const found = findPlaces(text);
    if (found.ambiguous && !found.counties.length) {
      return {
        text: `There is more than one ${found.ambiguous[0].name}. Which one did you mean?`,
        items: found.ambiguous.slice(0, 8).map((d) => ({...placeOf(d, "county"), value: ""}))
      };
    }

    const low = /\blow|least|worst|bottom|fewest|poor|lack|最低|最少|最差|缺/i.test(text);
    const high = /\bhigh|most|best|\btop\b|greatest|最高|最多|最好/i.test(text);
    const byProviders = /provider|clinic|facilit|医疗|机构|诊所/i.test(text);
    if ((low || high) && !found.counties.length) {
      const wantsStates = /\bstates?\b|州/i.test(text) && !/count(y|ies)|县/i.test(text);
      const scope = found.states[0] ?? null;
      const level = wantsStates || (!scope && !/count(y|ies)|县/i.test(text)) ? "state" : "county";
      const n = Math.min(15, Math.max(1, +(text.match(/\b(\d{1,2})\b(?!\s*(min|分))/)?.[1] ?? text.match(/前\s*(\d{1,2})/)?.[1] ?? 5)));
      const key = byProviders ? `p_${s.metric}` : s.metric;
      let rows = (level === "state" ? states : counties).filter((d) => d.pop > 0 && d[key] != null);
      if (level === "county" && scope) rows = rows.filter((d) => d.state_fips === scope.state_fips);
      const sign = low ? 1 : -1;
      rows = [...rows].sort((a, b) => sign * (a[key] - b[key]) || b.pop - a.pop).slice(0, n);
      const where = level === "county" ? (scope ? ` in ${scope.name}` : " in the US") : "";
      const what = byProviders ? "providers in reach" : "share of people within reach";
      const extreme = byProviders ? (low ? "fewest" : "most") : low ? "lowest" : "highest";
      const tied = !byProviders && low && rows.length && rows[rows.length - 1][key] === 0
        ? ` Several ${level === "state" ? "states" : "counties"} are tied at 0%; these are the most populated.` : "";
      return {
        text: `${lead} The ${rows.length} ${level === "state" ? "states" : "counties"}${where} with the ${extreme} ${what}:${tied}`,
        items: rows.map((d) => ({...placeOf(d, level), value: byProviders ? `${fmt.whole(d[key])} providers` : fmt.percent(d[key])})),
        ordered: true
      };
    }

    const places = [
      ...found.counties.map((d) => ({row: countyById.get(d.county_fips), level: "county"})),
      ...found.states.map((d) => ({row: stateById.get(d.state_fips), level: "state"}))
    ].filter((d) => d.row);
    if (places.length) {
      return {
        text: places.length > 1 ? `${lead} Comparing ${places.length} places:` : lead,
        items: places.map(({row, level}) => summary(row, level, s, fmt))
      };
    }

    if (found.regions.length) {
      return {
        text: `${lead} By Census region:`,
        items: regionRows.filter((r) => found.regions.includes(r.region)).map((r) => ({label: r.region, value: `${fmt.percent(r[s.metric])} within ${s.minutes} min (15 min: ${fmt.percent(r[`${s.service}_15`])}, 30 min: ${fmt.percent(r[`${s.service}_30`])})`}))
      };
    }

    if (/\b(us|usa|united states|nation|national|country|america)\b|全国|美国/i.test(text) || /region|地区|分区/i.test(text)) {
      return {
        text: `${lead} Across the United States, ${fmt.percent(qa.national[s.metric])} of people are within reach: ${fmt.whole(qa.national_reach[s.metric])} people, with ${fmt.whole(qa.national_providers[s.metric])} providers. By region:`,
        items: regionRows.map((r) => ({label: r.region, value: fmt.percent(r[s.metric])}))
      };
    }

    return {
      text: "I couldn't match that to a place or a ranking. Try naming a county with its state, a state, or ask for the lowest or highest places. I can only look up the figures on this page.",
      suggestions: true
    };
  };
}

function capitalize(text) {
  return text[0].toUpperCase() + text.slice(1);
}

function help() {
  return {
    text: "Ask about places and access on this page. You can name a service (any provider, emergency, crisis team, walk-in) and a drive time (15 or 30 minutes). For example:",
    suggestions: true
  };
}

export const EXAMPLES = [
  "Which 5 states have the lowest access?",
  "Counties in Texas with the lowest crisis team access",
  "Cook County, IL",
  "How many providers can people in Los Angeles County reach within 30 minutes?",
  "Compare Ohio and Michigan for walk-in",
  "Midwest emergency services"
];
