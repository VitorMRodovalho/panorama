# Naming conventions

Used consistently across code, APIs, docs. Keep this short; update when conflicts arise.

## Code

- **Files**: `kebab-case.ts` for code, `PascalCase.ts` for React components
- **Types / classes / enums**: `PascalCase`
- **Functions / variables**: `camelCase`
- **Constants**: `UPPER_SNAKE` only for module-level truly-constant values
- **Boolean variables**: start with `is`, `has`, `can`, `should`
- **Async functions**: no explicit `Async` suffix; the `Promise<T>` return type is enough

## API

- **REST paths**: `kebab-case`, plural nouns (`/assets`, `/asset-models`, `/reservations`)
- **JSON keys**: `camelCase` on the wire (TypeScript default)
- **Headers**: `X-Panorama-<...>` for custom headers
- **Event names**: `panorama.<domain>.<past_tense_verb>` (e.g., `panorama.asset.checked_out`)

## Database

- **Tables**: `snake_case`, plural (`assets`, `asset_models`, `reservations`)
- **Columns**: `snake_case` (`tenant_id`, `asset_tag`, `created_at`)
- **Timestamps**: always `created_at`, `updated_at`, `deleted_at` (nullable for soft delete)
- **Foreign keys**: `<ref>_id` (`tenant_id`, `asset_id`)
- **Indexes**: `ix_<table>_<cols>` (`ix_assets_tenant_id_status`)
- **Constraints**: `uq_<table>_<cols>` / `fk_<table>_<ref>`

## Tenancy

- Database column: `tenant_id`
- API field: `tenantId`
- UI label: **"Company"** (users recognise this from Snipe-IT and fleet workflows;
  "tenant" is a technical term that doesn't translate well to PT-BR / ES)

## Localisation keys

- `<feature>.<subfeature>.<label>`
- Prefer domain words over UI words: `reservation.status.pending` beats
  `ui.badges.yellow`

## Versioning

- **Code**: SemVer (major.minor.patch)
- **Prisma schema**: tagged by the Panorama version it ships in
- **Plugin SDK**: its own SemVer; plugins declare compatible ranges in their manifest
