# ADR-0007: Tenant Owner role (designated admin)

- Status: Proposed
- Date: 2026-04-18
- Deciders: Vitor Rodovalho
- Related: [ADR-0008 Invitation flow](./0008-invitation-flow.md)

## Context

Every Panorama tenant needs at least one human who is unambiguously
responsible for it — **the Tenant Owner**. This is the person who
authorised the tenant's existence, whose payment method funds it (on
Cloud), and who cannot be locked out by other admins of the same tenant.

The recurring failure mode we're defending against is **the orphaned
tenant**: the sole admin leaves the company, their account is
deactivated in the IdP, and now nobody can invite new members,
change settings, or delete the tenant. Support has to step in and run
privileged operations — expensive for us, slow for the customer.

Snipe-IT has no formal "Owner" concept — any user with Admin rights on
a given Company is equal to every other admin, and "Super User" is a
platform-global role. In practice Snipe-IT deployments either designate
an owner informally (not enforced by the system) or rely on the Super
User to intervene. Both are below the bar for multi-tenant SaaS.

## Prior art

| Product | Model | Can demote last? | Default at tenant creation |
|---------|-------|------------------|----------------------------|
| **GitHub org** | Owner(s), plural allowed. Recommends 2+ owners. | No — must demote self only if another owner exists | Creator is Owner |
| **Stripe** | Owner (1) + Admins | No | Account creator |
| **Linear** | Workspace Owner (1, transferable) + Admins | No — transfer first | Creator |
| **Slack** | Primary Owner (1) + Workspace Owners (N) + Admins | Primary cannot be demoted; must transfer | Creator = Primary |
| **Microsoft 365** | Global Admin(s). Max 5 enforced; emergency "break-glass" accounts recommended. | System allows it but UX warns | Billing owner |
| **AWS** | Root account | No (root is eternal) | Account creator |
| **Notion** | Workspace Owner (N) + Members | No — at least one owner required | Creator |

Pattern across all of them:
1. **At least one Owner at all times**, DB-enforced or service-enforced.
2. **Creator of the tenant is the first Owner** by default.
3. **Multiple Owners allowed** in most (AWS excepted) — best-practice
   explicit recommendation in GitHub / M365 / Slack.
4. **Demotion of the last Owner is impossible** without an explicit
   transfer to someone else.
5. **Owner has rights beyond Admin** — usually: delete the tenant,
   transfer ownership, change billing, invite other Owners.

## Decision

Panorama adds **`owner`** as a distinct role value on
`TenantMembership.role`, alongside the existing `fleet_admin`,
`fleet_staff`, `driver`.

### Rules (enforced in service layer + DB trigger)

1. **Every tenant MUST have at least one `owner` membership with
   `status = 'active'`.** This is a service-layer invariant plus a
   Postgres trigger that refuses inserts/updates that would drop the
   count to zero.

2. **The creator of a tenant is automatically its first Owner.** The
   `tenants` table INSERT path (via super-admin CLI or admin self-
   service signup) inserts the `TenantMembership` with `role='owner'`
   in the same transaction.

3. **Multiple Owners are allowed and encouraged.** The admin UI shows
   a yellow banner when a tenant has exactly one Owner, suggesting a
   second (single-point-of-failure warning, copied from GitHub).

4. **An Owner cannot demote themselves while they are the only
   Owner.** They must either promote another user first, or explicitly
   transfer ownership.

5. **Ownership transfer is a two-step flow** (expansion in 0.3):
   - Current Owner issues a transfer invitation to a target user
   - Target accepts → they become an Owner + (optionally) current
     Owner is demoted to `fleet_admin` if they asked for a
     "transfer" rather than "share"
   - Audit event: `panorama.tenant.ownership_transferred`

6. **Owner rights (superset of fleet_admin):**
   - Delete the tenant (soft delete + 30-day recovery window)
   - Rename the tenant (slug change requires Owner)
   - Change billing (Cloud edition; no-op on Community)
   - Promote another member to Owner
   - Demote another Owner to fleet_admin (if another Owner remains)
   - Manage `allowedEmailDomains`

7. **Super Admin escape hatch.** A Panorama Super Admin (platform
   operator, not tenant-scoped) can forcibly restore an orphaned
   tenant's ownership via a CLI break-glass command. Every such
   invocation writes an audit event with the operator's identity
   and a required `reason` parameter.

8. **Owner cannot be suspended** (status='suspended'). If a tenant
   needs to suspend an Owner, they must first demote to fleet_admin.

### Schema impact

`TenantMembership.role` is already a `String`. No schema change —
Panorama accepts `'owner'` as a valid value. What we add:

- Postgres trigger on `tenant_memberships` that refuses DELETE / UPDATE
  on a row whose effect would drop active-owner count to zero.
- Service-layer guards in `TenantAdminService.demoteMembership()` etc.
- The seed script creates an Owner membership when creating a tenant.

### Migration from existing data (FleetManager + import path)

During migration from Snipe-IT:

- Each imported tenant needs an Owner. The `Invited-By` of the first
  `fleet_admin`-group Snipe-IT user becomes the Panorama Owner.
- If no fleet_admin exists in Snipe-IT for a tenant, the migrator flags
  it in `inventory.json` and refuses to migrate until the operator
  nominates an Owner via `--owner-email=...` on the `migrate` CLI.

### Break-glass / support access

`panorama tenant nominate-owner --tenant=slug --email=...` is a
super-admin-only CLI command. Emits an audit event visible to the
tenant's other admins post-facto. Never hidden from them.

## Alternatives considered

### Single global "Super Admin" plays the Owner role

What Snipe-IT effectively does. Rejected: couples the tenant to the
platform operator, which is wrong for both self-hosted (customer
operates the platform themselves) and SaaS (one platform, many
tenants — each needs its own owner).

### `isOwner Boolean` flag instead of a role value

Considered. Rejected because:

- A user can only have one `role` at a time in our model; muddling
  role + flag creates two sources of truth for "what can this member do".
- Adding a flag means every authorisation check has to consult TWO
  columns. Service-layer logic gets noisier.

### Multiple distinct owner roles (Primary vs Secondary)

What Slack does (Primary Owner vs Workspace Owner). Rejected for 0.x:
the Slack primary-owner distinction exists mostly because of billing /
legal attribution at their scale. We don't need the complexity yet.
Revisit when/if it's actually requested.

### Owner is determined by a separate `tenantOwnerUserId` column on Tenants

Simpler to reason about but breaks when we want multiple owners, and
requires keeping the owner's membership consistent with the column.
Rejected.

## Consequences

### Positive

- No tenant can become orphaned by losing its last admin.
- Clear authorisation story for tenant-level operations (delete,
  transfer, billing) — they're gated on `role='owner'`.
- Support engineers know exactly who is accountable for each tenant.
- Maps cleanly to every enterprise sales conversation about "who owns
  the account".

### Negative

- Extra complexity on the membership demote / delete paths.
- Postgres trigger has to be written and tested per migration.
- Migration-from-Snipe-IT requires an operator decision when a tenant
  has no clear admin, slowing down bulk migrations.

### Neutral

- Enterprise tier can extend this with a separate `BillingContact`
  role and SCIM-pushed Owner synchronisation. Community's model is
  forward-compatible with those additions.

## Execution order

Not implemented at the moment this ADR is written. Sequencing:

1. **0.2 step 3b (web login, next up)** — no owner enforcement required
   since tenants are seeded via super-admin tooling only.
2. **0.2 step 3c (invitation flow, ADR-0008)** — introduces the paths
   where "make this member an owner" needs to be called.
3. **0.2 step 3d (owner enforcement)** — Postgres trigger + service
   guards + banner in admin UI. First commit to use the `role='owner'`
   value in practice.
4. **0.3** — break-glass CLI, audit events, admin transfer-ownership UI.
