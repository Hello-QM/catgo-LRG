export interface ElementRadiusData {
  atomic_number: number
  covalent_radius_pm: number
}

export type CovalentRadiiData = Record<string, ElementRadiusData>

declare const data: CovalentRadiiData
export default data
