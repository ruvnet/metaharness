// POST /v1/completions (ADR-203 §2). Legacy OpenAI completions shape; shares the same
// auth → tier → route → meter pipeline as chat/completions. Skeleton returns 501.
import type { Request, Response } from 'express';
import type { ErrorEnvelope } from '../types/openai';

export async function postCompletions(req: Request, res: Response): Promise<void> {
  const requestId = String(req.headers['x-request-id'] ?? '');
  const body: ErrorEnvelope = {
    error: 'apicompletions skeleton — completions not yet implemented (ADR-203 §2)',
    code: 'not_implemented',
    requestId,
  };
  res.status(501).json(body);
}
