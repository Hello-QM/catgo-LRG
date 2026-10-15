/** Points and polylines drawn over the structure by wavefunction analyses. */

export type Vec3Tuple = [number, number, number];

export interface OverlayMarker {
  position: Vec3Tuple;
  color: string;
  /** Sphere radius in Å */
  radius: number;
}

export interface OverlayPolyline {
  points: Vec3Tuple[];
  color: string;
}

export interface AnalysisOverlayData {
  markers: OverlayMarker[];
  lines: OverlayPolyline[];
}

export const EMPTY_OVERLAY: AnalysisOverlayData = { markers: [], lines: [] };

/** Multiwfn's usual colours for (3,-3), (3,-1), (3,+1) and (3,+3) critical points. */
export const CP_COLORS: Record<string, string> = {
  NCP: `#8b5cf6`,
  BCP: `#f97316`,
  RCP: `#eab308`,
  CCP: `#22c55e`,
};

/** How the structure view should display a cube produced by an analysis. */
export interface CubeDisplayOptions {
  /** Grid that colours the isosurface */
  color_file?: File;
  color_scale?: import("$lib/cube/vertex-colors").ColorScale;
  color_label?: string;
  /** Starting isovalue */
  isovalue?: number;
}

export function cube_file(text: string, name: string): File {
  return new File([text], name, { type: `chemical/x-cube` });
}
