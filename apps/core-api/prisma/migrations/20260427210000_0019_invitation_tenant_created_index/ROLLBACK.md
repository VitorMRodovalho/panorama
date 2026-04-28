# Rollback — migration 0019 (Invitation tenant+createdAt index)

```sql
DROP INDEX IF EXISTS "invitations_tenantId_createdAt_idx";
```

Index-only migration. No data shape change, no RLS change, no
application-side rollback needed beyond reverting the service code
to the pre-#64 client-side filter — but the rolled-back service
keeps working against the dropped-index database (just slower).
