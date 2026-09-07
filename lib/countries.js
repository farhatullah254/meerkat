/**
 * Search Console reports countries as lowercase ISO 3166-1 alpha-3.
 *
 * Worth spelling out on screen: `ind` is India and `idn` is Indonesia. Both are
 * major markets for these sites, they sit next to each other in every list, and
 * reading one as the other inverts the conclusion.
 */
const NAMES = {
  ago: 'Angola', are: 'UAE', arg: 'Argentina', arm: 'Armenia', aus: 'Australia',
  aut: 'Austria', aze: 'Azerbaijan', bel: 'Belgium', bgd: 'Bangladesh', bgr: 'Bulgaria',
  bih: 'Bosnia', bra: 'Brazil', brb: 'Barbados', brn: 'Brunei', can: 'Canada',
  che: 'Switzerland', chl: 'Chile', civ: 'Côte d’Ivoire', col: 'Colombia', cri: 'Costa Rica',
  cze: 'Czechia', deu: 'Germany', dom: 'Dominican Rep.', dza: 'Algeria', egy: 'Egypt',
  esp: 'Spain', fin: 'Finland', fra: 'France', gbr: 'UK', geo: 'Georgia',
  gha: 'Ghana', glp: 'Guadeloupe', grc: 'Greece', hnd: 'Honduras', hrv: 'Croatia',
  hun: 'Hungary', idn: 'Indonesia', ind: 'India', irn: 'Iran', irq: 'Iraq',
  isr: 'Israel', ita: 'Italy', jam: 'Jamaica', jpn: 'Japan', kaz: 'Kazakhstan',
  ken: 'Kenya', khm: 'Cambodia', kor: 'South Korea', kwt: 'Kuwait', lbn: 'Lebanon',
  lka: 'Sri Lanka', ltu: 'Lithuania', lva: 'Latvia', mar: 'Morocco', mex: 'Mexico',
  mmr: 'Myanmar', mus: 'Mauritius', mwi: 'Malawi', mys: 'Malaysia', nga: 'Nigeria',
  nic: 'Nicaragua', nld: 'Netherlands', nor: 'Norway', npl: 'Nepal', pak: 'Pakistan',
  per: 'Peru', phl: 'Philippines', pol: 'Poland', prt: 'Portugal', rou: 'Romania',
  rwa: 'Rwanda', sau: 'Saudi Arabia', sen: 'Senegal', sgp: 'Singapore', sle: 'Sierra Leone',
  srb: 'Serbia', swe: 'Sweden', tha: 'Thailand', tto: 'Trinidad', tun: 'Tunisia',
  tur: 'Türkiye', ukr: 'Ukraine', usa: 'USA', uzb: 'Uzbekistan', vnm: 'Vietnam',
  zaf: 'South Africa', zwe: 'Zimbabwe',
};

export function countryName(code) {
  if (!code) return '';
  return NAMES[String(code).toLowerCase()] ?? String(code).toUpperCase();
}
