-- Harborline AP database schema.
--
-- Conventions:
--   * Money is BIGINT cents (column names end in _cents). Never floats: 0.1 + 0.2 != 0.3 in floating point,
--     and an AP system must reconcile to the cent. Rates (tax, FX) are NUMERIC because they are not money.
--   * IDs from the dataset (U001, V001, AP-00001...) are kept as TEXT primary keys so every row can be
--     cross-referenced with TRAP_MAP.md and the CSVs during the demo.
--   * Tables that mirror a CSV keep the CSV's column names; columns we added for the app are grouped
--     under an "app columns" comment.
--   * Foreign keys between users and departments point both ways (a department has a manager, a user has a
--     department), so they are DEFERRABLE: the seed inserts both tables in one transaction and Postgres
--     checks them at COMMIT.

-- ───────────────────────────── Organization ─────────────────────────────

CREATE TABLE departments (
    department_id        TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    cost_centre          TEXT NOT NULL,
    annual_budget_cents  BIGINT NOT NULL,
    manager_user_id      TEXT NOT NULL            -- FK added below, after users exists
);

CREATE TABLE users (
    user_id               TEXT PRIMARY KEY,
    full_name             TEXT NOT NULL,
    email                 TEXT NOT NULL UNIQUE,
    title                 TEXT NOT NULL,
    department_id         TEXT NOT NULL REFERENCES departments DEFERRABLE INITIALLY DEFERRED,
    manager_id            TEXT REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    role                  TEXT NOT NULL CHECK (role IN
                            ('employee', 'ap_clerk', 'approver', 'finance_manager', 'controller_admin', 'auditor')),
    approval_limit_cents  BIGINT NOT NULL,
    work_province         TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('active', 'on_leave', 'terminated')),
    status_since          DATE,
    delegate_user_id      TEXT REFERENCES users DEFERRABLE INITIALLY DEFERRED,
    hire_date             DATE NOT NULL
);

ALTER TABLE departments
    ADD FOREIGN KEY (manager_user_id) REFERENCES users DEFERRABLE INITIALLY DEFERRED;

-- ───────────────────────────── Reference data ─────────────────────────────

CREATE TABLE gl_accounts (
    account_number  TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    account_type    TEXT NOT NULL,
    notes           TEXT
);

CREATE TABLE tax_codes (
    code         TEXT PRIMARY KEY,
    description  TEXT NOT NULL,
    rate         NUMERIC(7, 5) NOT NULL,
    applies_to   TEXT NOT NULL CHECK (applies_to IN ('all', 'goods')),
    recoverable  TEXT NOT NULL,                     -- 'yes' / 'no' / 'n/a', kept as in the CSV
    gl_account   TEXT REFERENCES gl_accounts
);

CREATE TABLE fx_rates (
    date        DATE PRIMARY KEY,
    usd_to_cad  NUMERIC(10, 4) NOT NULL
);

CREATE TABLE approval_policies (
    rule_id          TEXT PRIMARY KEY,
    rule_type        TEXT NOT NULL CHECK (rule_type IN ('approval', 'payment_release', 'match')),
    condition        TEXT NOT NULL,
    required         TEXT NOT NULL,
    notes            TEXT,
    -- app columns
    -- DECISION: the dollar threshold is parsed out of the condition text at seed time ("over $10,000" ->
    -- 1000000). Routing reads it from here, so changing a limit is a data change, not a code change. That is
    -- what makes P01–P04 and P09–P10 "configurable" without building a rules engine.
    threshold_cents  BIGINT
);

-- ───────────────────────────── Vendors ─────────────────────────────

CREATE TABLE vendors (
    vendor_id                 TEXT PRIMARY KEY,
    legal_name                TEXT NOT NULL,
    category                  TEXT NOT NULL,
    default_gl_account        TEXT REFERENCES gl_accounts,
    address                   TEXT,
    province_or_state         TEXT,
    country                   TEXT NOT NULL,
    gst_hst_number            TEXT,
    qst_number                TEXT,
    payment_terms_days        INT,
    early_pay_discount        TEXT,                 -- e.g. '2/10 net 30'
    preferred_payment_method  TEXT CHECK (preferred_payment_method IN ('EFT', 'CHEQUE', 'CARD')),
    accepts_card_payment      BOOLEAN NOT NULL,
    -- Bank fields are TEXT, not numbers: institution '004' and transit '05541' have meaningful leading zeros.
    bank_institution          TEXT,
    bank_transit              TEXT,
    bank_account              TEXT,
    bank_details_updated_at   DATE,
    ap_contact_email          TEXT,
    requires_po               BOOLEAN NOT NULL,
    status                    TEXT NOT NULL CHECK (status IN ('active', 'pending_review', 'on_hold')),
    onboarded_at              DATE
);

CREATE TABLE bank_change_history (
    change_id             TEXT PRIMARY KEY,
    vendor_id             TEXT NOT NULL REFERENCES vendors,
    changed_at            DATE NOT NULL,
    changed_by_user_id    TEXT REFERENCES users,
    request_channel       TEXT NOT NULL,            -- phone_callback_verified / vendor_portal / email_request / ...
    verified_by_callback  BOOLEAN NOT NULL,
    old_account_last4     TEXT,
    new_account_last4     TEXT,
    -- app columns (filled when a bank change is requested or verified through the app)
    new_bank_institution  TEXT,
    new_bank_transit      TEXT,
    new_bank_account      TEXT,
    callback_by_user_id   TEXT REFERENCES users,
    callback_at           TIMESTAMPTZ,
    callback_phone        TEXT,
    callback_outcome      TEXT
);

CREATE TABLE contracts (
    contract_id                  TEXT PRIMARY KEY,
    vendor_id                    TEXT NOT NULL REFERENCES vendors,
    description                  TEXT NOT NULL,
    billing_type                 TEXT NOT NULL CHECK (billing_type IN ('fixed_monthly', 'rate_card', 'blanket', 'retainer')),
    monthly_fee_cents            BIGINT,
    currency                     TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
    hourly_rate_cap_cents        BIGINT,
    fuel_surcharge_cap_pct       NUMERIC(5, 2),
    not_to_exceed_monthly_cents  BIGINT,
    start_date                   DATE NOT NULL,
    end_date                     DATE NOT NULL,
    auto_renew                   BOOLEAN NOT NULL,
    status                       TEXT NOT NULL CHECK (status IN ('active', 'expired'))
);

CREATE TABLE purchase_orders (
    po_id              TEXT PRIMARY KEY,
    vendor_id          TEXT NOT NULL REFERENCES vendors,
    department_id      TEXT NOT NULL REFERENCES departments,
    requester_user_id  TEXT NOT NULL REFERENCES users,
    issue_date         DATE NOT NULL,
    description        TEXT NOT NULL,
    total_amount_cents BIGINT NOT NULL,
    currency           TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
    status             TEXT NOT NULL CHECK (status IN ('open', 'partially_invoiced', 'closed')),
    approved_by        TEXT REFERENCES users
);

-- ───────────────────────────── Inbox and documents ─────────────────────────────

CREATE TABLE emails (
    email_id        TEXT PRIMARY KEY,
    from_name       TEXT,
    from_address    TEXT NOT NULL,
    to_address      TEXT NOT NULL,
    subject         TEXT NOT NULL,
    received_at     TIMESTAMP NOT NULL,
    body            TEXT NOT NULL,
    attachments     TEXT[] NOT NULL,
    -- app columns, filled by intake
    classification  TEXT,                           -- invoice / statement / newsletter / payment_inquiry / missing_attachment
    intake_status   TEXT NOT NULL DEFAULT 'unprocessed',
    intake_note     TEXT,
    processed_at    TIMESTAMPTZ
);

-- One row per uploaded or emailed file. The bytes live in Postgres (every file here is under 1 MB) so an
-- extraction worker on another machine only needs a database connection, not a shared disk.
CREATE TABLE documents (
    document_id   BIGSERIAL PRIMARY KEY,
    filename      TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    sha256        TEXT NOT NULL UNIQUE,             -- same file received twice = same document
    content       BYTEA NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('email', 'upload')),
    email_id      TEXT REFERENCES emails,
    uploaded_by   TEXT REFERENCES users,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Work queue for the extraction worker(s). Workers claim rows with SELECT ... FOR UPDATE SKIP LOCKED,
-- so any number of workers on any number of machines can pull from it without taking the same job twice.
CREATE TABLE extraction_jobs (
    job_id        BIGSERIAL PRIMARY KEY,
    document_id   BIGINT NOT NULL REFERENCES documents,
    status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts      INT NOT NULL DEFAULT 0,
    worker_id     TEXT,
    claimed_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What the worker read from a document: raw text plus parsed fields and a confidence per field.
CREATE TABLE extractions (
    extraction_id     BIGSERIAL PRIMARY KEY,
    document_id       BIGINT NOT NULL REFERENCES documents,
    engine            TEXT NOT NULL,                -- 'text_layer' or 'tesseract'
    raw_text          TEXT NOT NULL,
    fields            JSONB NOT NULL,
    field_confidence  JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────── Invoices ─────────────────────────────

-- Historical invoices from invoices.csv and new ones from intake share one table, so duplicate checks,
-- PO balances and payment history all look in one place.
CREATE TABLE invoices (
    invoice_id             TEXT PRIMARY KEY,
    vendor_id              TEXT REFERENCES vendors,  -- NULL when the vendor is not in the master yet
    vendor_invoice_number  TEXT,
    invoice_date           DATE,
    received_date          DATE,
    due_date               DATE,
    currency               TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
    subtotal_cents         BIGINT,
    gst_hst_cents          BIGINT,
    pst_qst_cents          BIGINT,
    total_cents            BIGINT,
    fx_rate_to_cad         NUMERIC(10, 4),
    total_cad_cents        BIGINT,
    department_id          TEXT REFERENCES departments,
    requester_user_id      TEXT REFERENCES users,
    po_id                  TEXT REFERENCES purchase_orders,
    contract_id            TEXT REFERENCES contracts,
    ship_to_province       TEXT,
    status                 TEXT NOT NULL CHECK (status IN (
                             -- statuses present in the history
                             'pending_approval', 'approved', 'scheduled', 'paid', 'rejected',
                             -- statuses added by the app
                             'extracting', 'needs_review', 'on_hold')),
    -- app columns
    source                 TEXT NOT NULL DEFAULT 'history' CHECK (source IN ('history', 'email', 'upload')),
    document_id            BIGINT REFERENCES documents,
    email_id               TEXT REFERENCES emails,
    is_credit_note         BOOLEAN NOT NULL DEFAULT false,
    hold_reason            TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- New invoice IDs continue the dataset's AP-xxxxx numbering. seed.py moves this past the highest seeded ID.
CREATE SEQUENCE invoice_number_seq;

CREATE TABLE invoice_lines (
    invoice_id     TEXT NOT NULL REFERENCES invoices ON DELETE CASCADE,
    line_no        INT NOT NULL,
    description    TEXT NOT NULL,
    quantity       NUMERIC(12, 3) NOT NULL,
    unit_price_cents BIGINT NOT NULL,
    amount_cents   BIGINT NOT NULL,
    gl_account     TEXT REFERENCES gl_accounts,
    department_id  TEXT REFERENCES departments,
    gst_hst_code   TEXT REFERENCES tax_codes,
    pst_qst_code   TEXT REFERENCES tax_codes,
    line_type      TEXT CHECK (line_type IN ('goods', 'services')),
    -- app columns: why this GL/department was suggested, and whether a person overrode it
    coding_reason  TEXT,
    coded_by       TEXT REFERENCES users,
    PRIMARY KEY (invoice_id, line_no)
);

-- Result of every validation check on an invoice. Re-running checks replaces the rows for that invoice.
CREATE TABLE check_results (
    check_id         BIGSERIAL PRIMARY KEY,
    invoice_id       TEXT NOT NULL REFERENCES invoices ON DELETE CASCADE,
    code             TEXT NOT NULL,                 -- e.g. FUEL_SURCHARGE_OVER_CAP
    severity         TEXT NOT NULL CHECK (severity IN ('block', 'warn', 'info')),
    message          TEXT NOT NULL,                 -- plain-language reason shown in the UI
    details          JSONB,
    acknowledged_by  TEXT REFERENCES users,         -- 'warn' results need a human acknowledgement
    acknowledged_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────── Approvals and payments ─────────────────────────────

CREATE TABLE approvals (
    approval_id           TEXT PRIMARY KEY,
    invoice_id            TEXT NOT NULL REFERENCES invoices,
    step_no               INT NOT NULL,
    approver_user_id      TEXT NOT NULL REFERENCES users,
    approver_role         TEXT NOT NULL,
    action                TEXT NOT NULL CHECK (action IN ('pending', 'approved', 'rejected')),
    acted_at              TIMESTAMP,
    comment               TEXT,
    -- app columns
    on_behalf_of_user_id  TEXT REFERENCES users,    -- set when the step was delegated (P08)
    rule_ids              TEXT,                     -- which policies created this step, e.g. 'P02' or 'P05'
    routing_note          TEXT,                     -- plain-language reason for this approver (escalation, delegation)
    UNIQUE (invoice_id, step_no)
);

CREATE SEQUENCE approval_number_seq;

CREATE TABLE payments (
    payment_id            TEXT PRIMARY KEY,
    invoice_id            TEXT NOT NULL REFERENCES invoices,
    vendor_id             TEXT NOT NULL REFERENCES vendors,
    method                TEXT NOT NULL CHECK (method IN ('EFT', 'CHEQUE', 'CARD')),
    scheduled_date        DATE,
    paid_date             DATE,
    currency              TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
    amount_cents          BIGINT NOT NULL,
    fx_rate_to_cad        NUMERIC(10, 4) NOT NULL,
    amount_cad_cents      BIGINT NOT NULL,
    discount_taken_cents  BIGINT NOT NULL DEFAULT 0,
    reference             TEXT,
    status                TEXT NOT NULL CHECK (status IN (
                            -- statuses present in the history
                            'scheduled', 'outstanding', 'settled',
                            -- statuses added by the app
                            'prepared', 'held', 'released', 'cancelled')),
    prepared_by           TEXT REFERENCES users,
    released_by           TEXT REFERENCES users,
    -- app columns
    credit_applied_cents  BIGINT NOT NULL DEFAULT 0, -- credit notes netted against this payment
    hold_reason           TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE payment_number_seq;

-- ───────────────────────────── Bank and card feeds ─────────────────────────────

CREATE TABLE bank_statement (
    bank_txn_id   TEXT PRIMARY KEY,
    posted_date   DATE NOT NULL,
    description   TEXT NOT NULL,
    debit_cents   BIGINT,
    credit_cents  BIGINT
);

CREATE TABLE card_transactions (
    txn_id               TEXT PRIMARY KEY,
    card_id              TEXT NOT NULL,
    cardholder_user_id   TEXT NOT NULL REFERENCES users,
    posted_date          DATE NOT NULL,
    merchant_descriptor  TEXT NOT NULL,
    mcc                  TEXT,
    amount_cents         BIGINT NOT NULL,
    currency             TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
    amount_cad_cents     BIGINT NOT NULL,
    source               TEXT NOT NULL CHECK (source IN ('employee_card', 'ap_virtual_card')),
    receipt_attached     BOOLEAN NOT NULL,
    memo                 TEXT
);

-- ───────────────────────────── Audit trail ─────────────────────────────

-- One append-only table for every state change. Timestamps are the real wall clock (when it happened),
-- while business rules use the configured "today" (2026-11-02).
CREATE TABLE audit_events (
    event_id              BIGSERIAL PRIMARY KEY,
    actor_user_id         TEXT REFERENCES users,    -- NULL for system actions (seed, worker)
    on_behalf_of_user_id  TEXT REFERENCES users,    -- set when acting as a delegate (P08)
    action                TEXT NOT NULL,            -- e.g. 'invoice.approve', 'payment.release'
    entity_type           TEXT NOT NULL,
    entity_id             TEXT NOT NULL,
    before                JSONB,
    after                 JSONB,
    reason                TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);

-- Append-only is enforced by the database itself, not just by the app: even a bug in our code, or
-- someone with a SQL prompt, cannot rewrite history. (A reseed drops the whole schema, which this allows.)
CREATE FUNCTION reject_audit_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_audit_change();

CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_change();

-- ───────────────────────────── Indexes used by checks ─────────────────────────────

CREATE INDEX invoices_vendor_idx ON invoices (vendor_id);
CREATE INDEX invoices_po_idx ON invoices (po_id);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);
CREATE INDEX approvals_invoice_idx ON approvals (invoice_id);
CREATE INDEX card_transactions_date_idx ON card_transactions (posted_date);
