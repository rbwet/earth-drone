// Turning "where do I want to fly" text into lon/lat.
//
// parseCoords handles anything coordinate-shaped: decimal degrees
// ("38.59, -90.35"), hemisphere suffixes ("38.59N 90.35W"), DMS as copied
// from Wikipedia (48°51′29″N 2°17′40″E), and Google Maps URLs (@lat,lon).
// geocode() handles everything else via OpenStreetMap Nominatim — free,
// no API key, so it works for both Google-key and ion-token users.

// One coordinate component: degrees, optional minutes/seconds, optional
// hemisphere letter. Accepts ° º d : for degrees, ' ′ m for minutes,
// " ″ s for seconds, or plain spaces between the numbers.
const PART_RE = /^([+-]?\d+(?:\.\d+)?)(?:[°ºd:\s]+(\d+(?:\.\d+)?)(?:['′m:\s]+(\d+(?:\.\d+)?)\s*["″s]?)?)?\s*([NSEW])?$/i;

function parsePart(text) {
  const m = text.trim().match(PART_RE);
  if (!m) return null;
  const deg = parseFloat(m[1]);
  const min = m[2] ? parseFloat(m[2]) : 0;
  const sec = m[3] ? parseFloat(m[3]) : 0;
  const hemi = m[4] ? m[4].toUpperCase() : null;
  let value = Math.abs(deg) + min / 60 + sec / 3600;
  if (deg < 0) value = -value;
  if (hemi === "S" || hemi === "W") value = -Math.abs(value);
  if (hemi === "N" || hemi === "E") value = Math.abs(value);
  return { value, hemi };
}

const latOk = (v) => Number.isFinite(v) && Math.abs(v) <= 90;
const lonOk = (v) => Number.isFinite(v) && Math.abs(v) <= 180;

// Returns { lat, lon } or null if the text isn't coordinate-shaped.
export function parseCoords(text) {
  text = text.trim();

  // Google Maps URL or anything with an @lat,lon in it.
  const url = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (url) {
    const lat = parseFloat(url[1]), lon = parseFloat(url[2]);
    return latOk(lat) && lonOk(lon) ? { lat, lon } : null;
  }

  // Split into two halves: comma first, then "after the N/S hemisphere
  // letter" for DMS pairs, then plain whitespace between two numbers.
  let halves = null;
  if (text.includes(",")) {
    const parts = text.split(",");
    if (parts.length === 2) halves = parts;
  } else {
    const dms = text.match(/^(.*?[NS])\s+(.*[EW])$/i);
    if (dms) halves = [dms[1], dms[2]];
    else {
      const nums = text.split(/\s+/);
      if (nums.length === 2) halves = nums;
    }
  }
  if (!halves) return null;

  const a = parsePart(halves[0]);
  const b = parsePart(halves[1]);
  if (!a || !b) return null;

  // Hemisphere letters decide which half is which; otherwise assume
  // "lat, lon" (the order Google Maps copies), swapping only if that's
  // out of range and the reverse isn't.
  let lat, lon;
  if (a.hemi === "E" || a.hemi === "W" || b.hemi === "N" || b.hemi === "S") {
    lat = b.value; lon = a.value;
  } else {
    lat = a.value; lon = b.value;
    if (!latOk(lat) && latOk(lon)) { [lat, lon] = [lon, lat]; }
  }
  return latOk(lat) && lonOk(lon) ? { lat, lon } : null;
}

// Bounding-box diagonal in meters — a proxy for how big the place is,
// used by the caller to pick a sensible spawn altitude.
function bboxSpanM(latMin, latMax, lonMin, lonMax, lat) {
  const mPerDeg = 111320;
  const dLat = (latMax - latMin) * mPerDeg;
  const dLon = (lonMax - lonMin) * mPerDeg * Math.cos(lat * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

async function nominatimSearch(query) {
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q="
    + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocoder error (HTTP ${res.status})`);
  const hits = await res.json();
  if (!hits.length) return null;

  const h = hits[0];
  const lat = parseFloat(h.lat);
  const lon = parseFloat(h.lon);
  if (!latOk(lat) || !lonOk(lon)) return null;

  let spanM = 0;
  if (Array.isArray(h.boundingbox) && h.boundingbox.length === 4) {
    const [latMin, latMax, lonMin, lonMax] = h.boundingbox.map(Number);
    spanM = bboxSpanM(latMin, latMax, lonMin, lonMax, lat);
  }
  return { lat, lon, name: h.name || h.display_name.split(",")[0], spanM };
}

async function photonSearch(query) {
  const url = "https://photon.komoot.io/api/?limit=1&lang=en&q=" + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocoder error (HTTP ${res.status})`);
  const json = await res.json();
  const f = json.features?.[0];
  if (!f) return null;

  const [lon, lat] = f.geometry.coordinates;
  if (!latOk(lat) || !lonOk(lon)) return null;

  let spanM = 0;
  const ext = f.properties.extent; // [west, north, east, south]
  if (Array.isArray(ext) && ext.length === 4) {
    spanM = bboxSpanM(ext[3], ext[1], ext[0], ext[2], lat);
  }
  return { lat, lon, name: f.properties.name || query, spanM };
}

// Free-text place lookup. Returns { lat, lon, name, spanM } or null when
// nothing matches. Nominatim first; if it's down or blocks us, Photon —
// both are OpenStreetMap data, so "no results" on the first is final.
export async function geocode(query) {
  try {
    return await nominatimSearch(query);
  } catch (err) {
    console.warn("[EarthDrone] Nominatim failed, trying Photon:", err.message ?? err);
    return photonSearch(query);
  }
}
