import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'gw_session';

export function requireCustomer(req: Request, res: Response, next: NextFunction): void {
  const customerId = req.signedCookies?.[SESSION_COOKIE] as string | undefined;
  if (!customerId) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  res.locals.customerId = customerId;
  next();
}
