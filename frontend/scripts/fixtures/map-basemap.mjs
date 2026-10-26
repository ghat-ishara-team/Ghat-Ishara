// Offline test-only basemap. Susceptibility overlays are never synthesized.
export const offlineBasemap = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAADIUlEQVR4nO3UMQHAIADAsDH/pri40AQyOJoo6NUx9zofkPS/DgDeMQAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIMwAIu1CLBVQhjI+4AAAAAElFTkSuQmCC','base64')

// Deterministic vector provider fixture for offline UI tests; never production geography.
export const offlineVectorStyle = {
  version: 8,
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#c1cdc7' } },
    { id: 'land', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover', paint: { 'fill-color': '#b0c0b5' } },
  ],
}
export async function mockVectorBasemap(route, failure = 'normal') {
  const url = new URL(route.request().url())
  if (failure === 'basemap-error') return route.fulfill({ status: 403, body: 'Test-only provider block' })
  if (failure === 'basemap-image') return route.fulfill({ status: 200, contentType: 'image/png', body: offlineBasemap })
  if (url.pathname.startsWith('/styles/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(offlineVectorStyle) })
  if (url.pathname === '/planet') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tilejson: '3.0.0', tiles: ['https://tiles.openfreemap.org/test-tiles/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 }) })
  if (url.pathname.endsWith('.pbf') && failure === 'basemap-tile-image') return route.fulfill({ status: 200, contentType: 'image/png', body: offlineBasemap })
  if (url.pathname.endsWith('.pbf')) return route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) })
  throw new Error('Unexpected offline basemap fixture resource')
}
