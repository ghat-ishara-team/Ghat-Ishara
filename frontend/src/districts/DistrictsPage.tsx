import { Link, NavLink, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Map, Mountain, ScanLine } from 'lucide-react'
import { colorScale, districtById, districtCatalog, districtMapURL } from '../map/config'
import { districtIntroductions } from './content'
import './districts.css'

type Raster = (typeof districtCatalog)[number]
const number = (value: number) => value.toLocaleString('en-IN')
const resolution = (district: Raster) => `${district.resolution[0]} × ${district.resolution[1]} m`
const coverage = (district: Raster) => `${(district.validFraction * 100).toFixed(2)}%`

function MapLink({ district }: { district: Raster }) {
  return <Link className="button button-green" to={districtMapURL(district.id)} aria-label={`View ${district.name} on Map`}><Map size={18} aria-hidden="true" />View on Map<ArrowRight size={17} aria-hidden="true" /></Link>
}

function ScientificNote() {
  return <aside className="district-science" aria-labelledby="science-title"><Mountain size={23} aria-hidden="true" /><div><h2 id="science-title">A research lens on the landscape.</h2><p>These experimental, uncalibrated scores describe relative landslide susceptibility. They are not event probabilities, real-time forecasts or operational warnings. Do not use them alone for emergency, travel or engineering decisions.</p></div></aside>
}

export function DistrictsOverview() {
  return <main id="main-content" tabIndex={-1} className="district-page page-width">
    <header className="district-hero">
      <p className="eyebrow">Western Ghats · Maharashtra</p>
      <h1>Four districts.<br /><span className="text-sage">One shared landscape.</span></h1>
      <p className="district-lead">From the Konkan coast to the Deccan plateau, explore the places behind the model. Each profile connects a real susceptibility raster with the context needed to read it responsibly.</p>
      <div className="district-summary"><span><ScanLine size={17} aria-hidden="true" />{[...new Set(districtCatalog.map(resolution))].join(' / ')} raster cells</span><span>{districtCatalog.length} source datasets</span><span>One fixed {colorScale.breaks[0]}–{colorScale.breaks.at(-1)} score scale</span></div>
    </header>
    <section aria-labelledby="district-list-title">
      <div className="district-section-heading"><h2 id="district-list-title">Choose a district</h2><p>Source metadata, without a risk ranking.</p></div>
      <div className="district-grid">{districtCatalog.map(district => <article className="district-card" key={district.id} aria-labelledby={`title-${district.id}`}>
        <p className="district-kicker">{districtIntroductions[district.id].landscape}</p>
        <h3 id={`title-${district.id}`}>{district.name}</h3>
        <p>{districtIntroductions[district.id].description}</p>
        <dl className="district-card-facts"><div><dt>Raster cell size</dt><dd>{resolution(district)}</dd></div><div><dt>Valid pixels / raster rectangle</dt><dd>{coverage(district)}</dd></div></dl>
        <p className="district-source-caption">Source raster <span>{district.source}</span></p>
        <div className="district-card-actions"><Link className="district-text-link" to={`/districts/${district.id}`} aria-label={`Explore district: ${district.name}`}>Explore district<ArrowRight size={17} aria-hidden="true" /></Link><MapLink district={district} /></div>
      </article>)}</div>
      <p className="district-coverage-note">Valid-pixel percentages describe the share of valid pixels inside each raster’s rectangular extent. They are not the percentage of a district covered or at risk.</p>
    </section>
    <ScientificNote />
  </main>
}

function RasterFacts({ district }: { district: Raster }) {
  return <section className="district-panel" aria-labelledby="dataset-title"><p className="eyebrow">Measured from the source raster</p><h2 id="dataset-title">Inside the dataset</h2>
    <dl className="district-facts">
      <div><dt>Raster spatial resolution</dt><dd>{resolution(district)}<small>Native raster cell spacing; not evidence of predictive accuracy at this scale.</small></dd></div>
      <div><dt>Observed model-score range</dt><dd data-testid="score-range">{String(district.minimum)} – {String(district.maximum)}<small>Minimum and maximum over valid source pixels; not a district risk ranking.</small></dd></div>
      <div><dt>Valid raster coverage</dt><dd data-testid="valid-coverage">{coverage(district)}<small>{number(district.validPixels)} valid pixels out of {number(district.width * district.height)} pixels inside the raster’s rectangular extent. This is not the percentage of the district covered or at risk.</small><small>Catalog fraction: {String(district.validFraction)}. Percentage above rounded to two decimal places.</small></dd></div>
      <div><dt>Raster dimensions</dt><dd>{number(district.width)} columns × {number(district.height)} rows</dd></div>
      <div><dt>Coordinate reference system</dt><dd>{district.crs}<small>WGS 84 / UTM zone 43N. Map display tiles use Web Mercator.</small></dd></div>
      <div><dt>Source dataset</dt><dd><code>{district.source}</code><small>Original {district.dtype} score raster · NoData sentinel {district.nodata}</small></dd></div>
      <div><dt>Source model tag</dt><dd><code>{district.tags.MODEL}</code><small>“250m” appears in the model and source filename. The measured raster grid spacing is {resolution(district)}.</small></dd></div>
    </dl>
    <details className="district-provenance"><summary>Source verification and geographic extent</summary><p>These values come from the validated raster catalog used by Map Explorer. Bounds describe the raster footprint, not an administrative boundary.</p><p>Geographic bounds (west, south, east, north): <code>{district.bounds.join(', ')}</code></p><p>SHA-256: <code>{district.sha256}</code></p><p>Source description: {district.tags.DESCRIPTION}. Rainfall units: {district.tags.RAINFALL_UNITS}.</p></details>
  </section>
}

function Interpretation() {
  return <section className="district-panel district-interpretation" aria-labelledby="interpretation-title"><p className="eyebrow">Reading the scores</p><h2 id="interpretation-title">A shared scale. Careful interpretation.</h2>
    <p>The same fixed 0–1 relative susceptibility score bands are used for all four districts. Higher scores indicate higher relative model susceptibility; a score of 0.8 does not mean an 80% chance of a landslide. Bands are not district-specific quantiles or validated warning thresholds.</p>
    <ul className="district-bands" aria-label={colorScale.label}>{colorScale.labels.map((label, index) => <li key={label}><span className="district-band-swatch" style={{ background: colorScale.colors[index] }} aria-hidden="true" /><span>{label}</span></li>)}</ul>
    <p>The first four bands include their lower bound and exclude their upper bound; the last band includes 1. Display tiles use nearest-neighbour sampling. Use location inspection in Map Explorer to read the original Float32 source-cell score, rather than estimating it from a colour.</p>
    <h3>NoData does not mean safe</h3><p>The source sentinel is −9999. Missing, excluded or outside-coverage cells have no valid displayed score. Transparency can also result from hidden layers, zero opacity or failed tile loading; it is never evidence of safety.</p>
    <h3>Uncertainty and scientific limitations</h3><p>This is experimental model output. The source tags explicitly mark rainfall units as unverified. The catalog provides no per-cell uncertainty estimates or calibrated event probabilities. It does not establish predictive accuracy, model validation performance or the timing of a future event.</p>
    <p>Raster cell spacing does not establish the effective resolution of the input predictors or model. Local conditions, changing rainfall, slope modifications and data gaps can affect interpretation. Use field assessment and authoritative local guidance for decisions.</p>
  </section>
}

export function DistrictProfile() {
  const { districtId } = useParams()
  const district = districtById(districtId)
  if (!district) return <main id="main-content" tabIndex={-1} className="district-page page-width"><p className="eyebrow">404 · District unavailable</p><h1>District not found.</h1><p className="district-lead">Choose one of the four study districts to view its source metadata and susceptibility map.</p><Link className="button button-green" to="/districts">Browse districts<ArrowRight size={18} aria-hidden="true" /></Link></main>
  return <main id="main-content" tabIndex={-1} className="district-page page-width">
    <Link className="back-link" to="/districts"><ArrowLeft size={16} aria-hidden="true" />All districts</Link>
    <header className="district-hero"><p className="eyebrow">District profile · Maharashtra</p><h1>{district.name}<span className="district-subtitle">{districtIntroductions[district.id].landscape}</span></h1><p className="district-lead">{districtIntroductions[district.id].description}</p><MapLink district={district} /></header>
    <nav className="district-tabs" aria-label="Study districts">{districtCatalog.map(item => <NavLink key={item.id} to={`/districts/${item.id}`}>{item.name}<ArrowRight size={15} aria-hidden="true" /></NavLink>)}</nav>
    <div className="district-profile-grid"><RasterFacts district={district} /><Interpretation /></div>
    <ScientificNote />
    <footer className="district-footer"><Link className="district-text-link" to="/districts"><ArrowLeft size={17} aria-hidden="true" />Back to all districts</Link><MapLink district={district} /></footer>
  </main>
}
