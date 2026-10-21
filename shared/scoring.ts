export interface InputScoreResult {
  id: string;
  label: string;
  source: "display" | "phone";
  value: number | null;
  samples: number;
  mode: "guide" | "stability";
  reason?: string;
}
export interface PerformanceScore {
  value: number;
  samples: number;
  mode: "guide" | "stability";
  inputs?: InputScoreResult[];
  aggregation?: "mean";
}
