export type VariationalDiagnosticOutcome = 'ok' | 'challenge' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'redirect' | 'html' | 'invalid_data' | 'timeout' | 'network_error' | 'cancelled';

export type VariationalDiagnosticResult = {
  endpoint: 'session' | 'portfolio';
  path: string;
  status: number | null;
  contentType: 'json' | 'html' | 'other' | 'missing' | null;
  challenge: boolean;
  elapsedMs: number;
  structureOk: boolean | null;
  outcome: VariationalDiagnosticOutcome;
};

export type VariationalDiagnosticReport = {
  checkedAt: string;
  client: 'asset-node';
  results: VariationalDiagnosticResult[];
};
