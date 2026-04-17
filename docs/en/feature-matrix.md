# Feature matrix — Community vs Enterprise

**Principle:** everything needed to run a real deployment lives in Community.
Enterprise is strictly **additive** — enterprise-class controls, niche IdPs,
compliance packs, branded support.

| Area | Community (AGPL-3.0) | Enterprise (commercial) |
|------|----------------------|-------------------------|
| **Assets** | Hardware, Licences, Accessories, Consumables, Components, Predefined Kits, bookable Vehicles, custom asset types via plugin SDK | Per-type depreciation rules, bulk-edit asset graph, lot/serial genealogy |
| **Custom fields** | Text, number, date, boolean, listbox, textarea, file; regex validation; per-model fieldsets | Cross-field validation rules, conditional visibility, referenced fields |
| **Reservations** | Advance booking, approval workflow, recurring reservations, blackouts, basket/multi-asset, VIP auto-approval, training-gating | Matrix approvals (n-of-m + tiers), delegated approvals, workflow-as-code |
| **Inspections** | Configurable checklists, photo evidence, EXIF strip, pre/post comparison, signature capture | Offline-first mobile, voice-to-text notes, on-device OCR of dashboards |
| **Maintenance** | Manual flagging, mileage + time alerts, vendor link, history | Predictive alerts from telematics, Fleetio/Samsara/GeoTab connectors |
| **Multi-tenancy**| Row-level tenancy (Prisma middleware + Postgres RLS), per-company RBAC | Cross-tenant service-account tokens, tenant-to-tenant asset transfer, data-residency pinning |
| **Authentication**| Email/password, Google OIDC, Microsoft OIDC, SAML (generic), LDAP, TOTP 2FA, WebAuthn passkeys | Okta advanced, PingFederate, JumpCloud SCIM push, ADFS, FIDO2 AAL-2 attestation |
| **Authorisation**| CASL-based RBAC, per-tenant group→role mapping, custom roles | ABAC / policy-as-code (Rego), time-windowed grants, break-glass audit |
| **API** | REST + OpenAPI 3.1, GraphQL optional, personal access tokens, OAuth2 client credentials, Snipe-IT compat shim | Signed HMAC webhooks at tenant level, customer-managed encryption keys for API tokens |
| **Notifications**| Email, Microsoft Teams, Slack, Google Chat, webhooks (HMAC) | PagerDuty, ServiceNow, per-tenant SMTP relay, dynamic routing rules |
| **Reports** | Built-ins + custom-SQL view builder, CSV export | Scheduled delivery, Looker/Metabase/Superset connector packs, XLSX & PDF |
| **Barcodes/Labels**| QR, Code-128, 128-auto, PDF/SVG templates, per-tenant defaults | Designer UI, Zebra label-printer direct print (ZPL), PrintNode bridge |
| **Importers** | CSV (idempotent, dry-run), Snipe-IT API migrator, FleetManager MySQL dump migrator | SAP Ariba, Oracle Fusion, Coupa, ServiceNow CMDB bi-directional sync |
| **Audit log** | Per-action immutable append, hash chain, export CSV | SIEM streaming (Splunk, Datadog, Elastic), SOC-2 evidence pack |
| **Observability**| Prometheus metrics, OTLP traces, structured logs | Managed observability bundle with dashboards + alerts |
| **Backups** | Spatie-style app-level backups + DB dump + object-store copy | Point-in-time recovery via WAL shipping, cross-region DR, restore drills |
| **White-label** | — (brand is "Panorama") | Per-tenant logo, colour, email templates, login page, custom domain |
| **Support** | Community (GitHub Discussions, Matrix/Discord) | 24×7 pager, 4-hour response SLA, named CSM |
| **Price** | Free | Per-seat, bands published on panorama.vitormr.dev |

## What Community will never hold back

These flows are **always complete** in Community:

- Check out, check in, scan QR
- Book a vehicle, approve/reject, ride it, return it
- Flag for maintenance, assign to a technician, track the repair
- Export any entity list to CSV
- View the audit log
- Migrate from Snipe-IT

If any of those depended on Enterprise code to be end-to-end usable, the
split has broken. The CI `ensure-community-complete` job asserts that the
Community test suite passes without the Enterprise packages installed.
