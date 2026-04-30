export interface ParsedWireSend {
  inboxId: string;
  from: string;
  body: string;
  reply_to?: string;
}
