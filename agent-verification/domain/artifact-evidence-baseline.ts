export interface ArtifactEvidenceBaseline {
  artifactId: string;
  kind: "file" | "contract";
  locator: string;
  status: "known" | "unknown";
  hash: string | null;
  reason: string | null;
}
export interface ProofBaseline {
  artifacts: ArtifactEvidenceBaseline[];
  environment: { platform: string; architecture: string; nodeVersion: string } | null;
}
