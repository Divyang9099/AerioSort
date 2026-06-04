// Parse a KML string and return GeoJSON-like feature list
export function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const features = []

  doc.querySelectorAll('Placemark').forEach(pm => {
    const name = pm.querySelector('name')?.textContent?.trim() || ''
    const desc = pm.querySelector('description')?.textContent?.trim() || ''

    // Point
    const ptCoords = pm.querySelector('Point > coordinates')
    if (ptCoords) {
      const [lon, lat, alt] = ptCoords.textContent.trim().split(',').map(Number)
      if (!isNaN(lat) && !isNaN(lon))
        features.push({ type: 'point', name, desc, lat, lon, alt: alt || 0 })
    }

    // LineString
    const lsCoords = pm.querySelector('LineString > coordinates')
    if (lsCoords) {
      features.push({ type: 'line', name, desc, coords: parseCoordsStr(lsCoords.textContent) })
    }

    // Polygon (outer boundary)
    const polyCoords = pm.querySelector('Polygon outerBoundaryIs LinearRing > coordinates')
      || pm.querySelector('Polygon > outerBoundaryIs > LinearRing > coordinates')
    if (polyCoords) {
      features.push({ type: 'polygon', name, desc, coords: parseCoordsStr(polyCoords.textContent) })
    }
  })

  return features
}

function parseCoordsStr(str) {
  return str.trim().split(/\s+/).flatMap(seg => {
    const parts = seg.split(',').map(Number)
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1]))
      return [{ lat: parts[1], lon: parts[0] }]
    return []
  })
}
