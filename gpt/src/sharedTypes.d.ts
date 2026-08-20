export type ResearchIntent = 'direct' | 'comparison' | 'contradiction' | 'quotation' | 'advice' | 'clarification';

export interface ResearchObjective {
  standalone_question: string;
  intent: ResearchIntent;
  language: string;
  entities: string[];
  facets: string[];
  probes: Array<{ text: string; purpose: 'primary' | 'comparison_side' | 'relationship' | 'counterevidence' | 'quotation' }>;
  memory: { topic: string; entities: string[]; unresolved: string[]; preferences: string[] };
}

export interface EvidenceRef {
  key: string;
  sourceId: string;
  sourceGroup?: string | null;
  passageIndex: number;
  start: number;
  end: number;
  excerpt: string;
  title?: string | null;
  metadata: Record<string, unknown>;
  locator: { book?: string; chapter?: string; page?: string | number; section?: string; [key: string]: unknown };
  channels: string[];
  scores: Record<string, number>;
  stance?: 'supports' | 'opposes' | 'qualifies' | 'context' | 'reconciles' | 'irrelevant';
  supportVerdict?: 'supported' | 'contradicted' | 'insufficient';
  citationNumber?: number;
}

export interface VerifiedClaim {
  text: string;
  evidenceIds: string[];
  verdict: 'supported' | 'contradicted' | 'insufficient';
}

export type TurnEvent =
  | { type: 'status'; turnId: string; stage: string; message: string }
  | { type: 'answer'; turnId: string; message: { id: string; role: 'assistant'; content: string; sources: EvidenceRef[] } }
  | { type: 'sources'; turnId: string; sources: EvidenceRef[] }
  | { type: 'done'; turnId: string; stats: Record<string, unknown>; objective: ResearchObjective; probes: ResearchObjective['probes'] }
  | { type: 'error'; turnId: string; error: string; cancelled?: boolean };
