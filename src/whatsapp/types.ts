/** Minimal shapes of the Cloud API webhook payload we actually consume. */

export interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
}

export interface WhatsAppInteractiveMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'interactive';
  interactive:
    | { type: 'button_reply'; button_reply: { id: string; title: string } }
    | { type: 'list_reply'; list_reply: { id: string; title: string; description?: string } }
    | { type: 'nfm_reply'; nfm_reply: { name: string; body?: string; response_json: string } };
}

export interface WhatsAppOtherMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
}

export type WhatsAppMessage = WhatsAppTextMessage | WhatsAppInteractiveMessage | WhatsAppOtherMessage;

export interface WhatsAppContact {
  wa_id: string;
  profile?: { name?: string };
}

export interface WhatsAppWebhookBody {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value: {
        messaging_product?: string;
        metadata?: { phone_number_id: string; display_phone_number: string };
        contacts?: WhatsAppContact[];
        messages?: WhatsAppMessage[];
        statuses?: Array<{
          id: string;
          status: string;
          recipient_id: string;
          timestamp?: string;
          pricing?: { category?: string; billable?: boolean };
          errors?: Array<{ code?: number; title?: string; message?: string }>;
        }>;
      };
    }>;
  }>;
}

/** Normalised inbound event handed to the conversation router. */
export interface InboundEvent {
  waId: string;
  messageId: string;
  profileName?: string;
  /** Free text the user typed, or the title of the button they pressed. */
  text: string;
  /** Payload id of a pressed button / selected list row, if any. */
  actionId?: string;
  /** Correlation token we set when sending a Flow, echoed back on submit. */
  flowToken?: string;
  /** Decoded answers from a Flow submission. */
  flowResponse?: Record<string, unknown>;
  /** Set for message types we cannot act on: image, audio, sticker, location. */
  unsupportedType?: string;
  receivedAt: Date;
}

/** A delivery receipt from Meta: sent -> delivered -> read, or failed. */
export interface StatusEvent {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  waId: string;
  occurredAt: Date;
  pricingCategory?: string;
  errorCode?: number;
  errorTitle?: string;
}

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}
