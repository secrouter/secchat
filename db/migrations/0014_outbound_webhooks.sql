-- Outbound webhooks: SecChat POSTs a signed JSON payload to an external URL when a subscribed
-- event fires in a channel (the opposite direction of the inbound `webhooks` table). `secret`
-- signs each delivery (HMAC-SHA256); `include_content` gates message-content egress (off by
-- default). The last_* columns record the most recent delivery attempt for observability.
CREATE TABLE outbound_webhooks (
  id               uuid PRIMARY KEY,
  channel_id       uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  url              text NOT NULL,
  secret           text NOT NULL,
  events           text[] NOT NULL,
  include_content  boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL,
  last_status      integer,
  last_error       text,
  last_delivery_at timestamptz
);

CREATE INDEX outbound_webhooks_channel_idx ON outbound_webhooks (channel_id);
