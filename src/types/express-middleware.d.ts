import { IncomingMessage, ServerResponse } from "http";

export type ExpressMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: any) => void,
) => void;
