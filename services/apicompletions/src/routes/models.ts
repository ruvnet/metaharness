// GET /v1/models (ADR-203 §3.4). Lists the four cognitum-* aliases, NOT the underlying
// pool (customers buy tiers, not models — keeps the pool swappable).
import type { Request, Response } from 'express';

const ALIASES = ['cognitum-auto', 'cognitum-low', 'cognitum-mid', 'cognitum-high'];

export function getModels(_req: Request, res: Response): void {
  res.json({
    object: 'list',
    data: ALIASES.map((id) => ({ id, object: 'model', owned_by: 'cognitum' })),
  });
}
