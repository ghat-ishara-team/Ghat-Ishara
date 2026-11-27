// Public summaries use the selected experiment's small saved result files.
// Keep interpretation aligned with frontend/METHODOLOGY_RESEARCH.md. Importing
// these read-only does not execute ML code or include training/geospatial data.
import recordedFolds from '../../../ml/data/controlled_250m_22pred_spatial_cv_results.csv?raw'
import report from '../../../ml/results/final_model_evaluation.json'
import foldDownload from '../../../ml/data/controlled_250m_22pred_spatial_cv_results.csv?url&no-inline'
import reportDownload from '../../../ml/results/final_model_evaluation.json?url&no-inline'

const rows = recordedFolds.trim().split(/\r?\n/).slice(1).map(line => {
  const [fold, samples, auc, recall, precision, f1] = line.split(',').map(Number)
  return { fold, samples, auc, recall, precision, f1 }
})
export const recordedCV = {
  folds: rows,
  means: Object.fromEntries((['auc', 'f1', 'recall', 'precision'] as const).map(key => [key, (rows.reduce((sum, row) => sum + row[key], 0) / rows.length).toFixed(6)])),
}
export const historicalReport = report
export { foldDownload, reportDownload }

// Names verified against the selected model bundle and district inference script.
// Friendly labels identify columns, not verified upstream derivation formulas.
export const predictorGroups = [
  { title: 'Terrain & orientation', description: 'Elevation, slope form and directional components.', inputs: [
    ['Elevation', 'elevation'], ['Slope', 'slope'], ['Aspect', 'aspect'], ['Northness', 'northness'], ['Eastness', 'eastness'], ['Curvature', 'curvature'], ['Ruggedness', 'ruggedness'],
  ] },
  { title: 'Soil properties', description: 'Three recorded layers for each soil variable. Depth units and source conversions remain unverified.', inputs: [
    ['Clay · 0–5', 'clay_0_5_pct'], ['Clay · 5–15', 'clay_5_15_pct'], ['Clay · 15–30', 'clay_15_30_pct'],
    ['Bulk density · 0–5', 'bdod_0_5_kg_dm3'], ['Bulk density · 5–15', 'bdod_5_15_kg_dm3'], ['Bulk density · 15–30', 'bdod_15_30_kg_dm3'],
    ['Coarse-fragment volume (name suggests) · 0–5', 'cfvo_0_5_pct'], ['Coarse-fragment volume (name suggests) · 5–15', 'cfvo_5_15_pct'], ['Coarse-fragment volume (name suggests) · 15–30', 'cfvo_15_30_pct'],
  ] },
  { title: 'Land surface', description: 'Land-cover codes and a vegetation index. Original products, dates and code definitions need verification.', inputs: [
    ['Land cover', 'landcover'], ['NDVI', 'ndvi'],
  ] },
  { title: 'Wetness & water context', description: 'A named wetness index, a static rainfall value and distance to mapped waterways. Rainfall units remain unverified.', inputs: [
    ['TWI', 'twi'], ['Rainfall climatology value', 'rainfall_climatology_value'], ['Distance to waterway (m)', 'distance_to_waterway_m'],
  ] },
  { title: 'Geology', description: 'Cleaned rock-type categories from mapped polygons; missing and water-body categories become UNKNOWN.', inputs: [
    ['Lithology', 'lithology_clean'],
  ] },
] as const
