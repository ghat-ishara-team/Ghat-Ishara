import type { AddProtocolAction } from 'maplibre-gl'

export const tileProtocol = 'ghat-susceptibility'
const prefix = `${tileProtocol}://`
/** Surface missing local tiles as failures: MapLibre otherwise treats HTTP 404 as empty coverage. */
export const fetchSusceptibilityTile: AddProtocolAction = async (parameters, controller) => {
  const path = parameters.url.slice(prefix.length)
  const match = /^generated-data\/susceptibility\/[a-z0-9-]+\/(pune|raigad|ratnagiri|satara)\/\d+\/\d+\/\d+\.png$/.exec(path)
  if (!parameters.url.startsWith(prefix) || !match) throw new Error('Invalid susceptibility tile request')
  try {
    const response = await fetch(`/${path}`, { signal: controller.signal, credentials: 'omit' })
    if (!response.ok || !response.headers.get('content-type')?.includes('image/png')) throw new Error('tile unavailable')
    const data = await response.arrayBuffer()
    const signature = new Uint8Array(data, 0, Math.min(data.byteLength, 8))
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => signature[index] === value)) throw new Error('invalid image')
    return { data, cacheControl: response.headers.get('cache-control') ?? undefined, expires: response.headers.get('expires') ?? undefined }
  } catch (error) {
    if (controller.signal.aborted) throw error
    // No provider response body, token, or query string is included in this error.
    throw new Error(`Susceptibility tile unavailable: ${match[1]}`)
  }
}
