# Panorama

> Una plataforma open-source para **activos de TI + flota operativa** — notebooks, vehículos, licencias, equipos, en un solo panel.
> Postgres RLS multi-tenant, OIDC, registro de auditoría con hash-chain, trilingüe EN/PT-BR/ES.
> AGPL-3.0 (fork-friendly). Vista previa hospedada gratuita próximamente.

<p align="center">
  <em>Un solo panel para notebooks, licencias, móviles, montacargas, furgonetas — y todo lo demás.</em>
</p>

---

## 🌐 Léelo en otro idioma

- **English** — [README.md](./README.md)
- **Português (Brasil)** — [README.pt-br.md](./README.pt-br.md)
- **Español** — estás aquí

---

## ¿Por qué Panorama?

Los equipos que gestionan tanto activos de TI (notebooks, licencias, móviles) como equipos
operativos (vehículos, montacargas, herramientas) terminan corriendo dos sistemas separados —
dos bases de datos, dos superficies de autenticación, dos pistas de auditoría, usuarios
duplicados y una integración frágil entre ellos.

Panorama es una sola plataforma para ambos. Modelo de dominio único, plano de datos único,
superficie de administración única. Multi-tenant por construcción (Postgres RLS forzado en
cada tabla scoped por tenant). Auditoría hash-chained, con detección de manipulación. UI
trilingüe desde el día 1 (EN/PT-BR/ES). Auto-hospédalo o usa la vista previa hospedada.

## Estado

🚧 **Acceso anticipado — abierto al uso, esperá aristas.** Inicio 2026-04-17.

- **Backend:** listo para producción (NestJS 11 + Prisma 6 + Postgres RLS + OIDC probado
  end-to-end vía [#92](https://github.com/VitorMRodovalho/panorama/issues/92)). Dependencias
  al día hasta 2026-05-09 ([#123](https://github.com/VitorMRodovalho/panorama/issues/123)).
- **App web:** en construcción activa. ~10% de la superficie de funcionalidades hoy;
  navegación + CRUD de activos + formularios de checkout en proceso
  ([#52](https://github.com/VitorMRodovalho/panorama/issues/52)).
- **Vista previa hospedada:** abre cuando la [Wave 0 readiness](./docs/audits/HANDOFF-2026-05-09-session-end.md)
  cierre (Privacy + ToS + status page + fix de audit chain + endpoint de export de datos).

Decisiones de arquitectura en [`docs/adr/`](./docs/adr/); estado actual + plan de olas en
[`docs/audits/HANDOFF-2026-05-09-session-end.md`](./docs/audits/HANDOFF-2026-05-09-session-end.md).

## Ediciones

| Edición       | Licencia      | Código     | Caso de uso                                                          |
|---------------|---------------|------------|----------------------------------------------------------------------|
| **Community** | AGPL-3.0      | Este repo  | Auto-hospedaje completo para cualquier tamaño, sin feature gating en el core |
| **Enterprise**| Comercial     | Repositorio privado `panorama-enterprise` (tomado en build time) | Conectores SSO especializados, paquetes de auditoría SOC-2, white-label, soporte 24×7 |
| **Vista previa hospedada** | Gratis (acceso anticipado) | Operado por nosotros | Instancia hospedada gratis para evaluación; abre cuando la Wave 0 readiness cierre (ver handoff) |

La edición **Community** es la implementación de referencia — todo en ella debe funcionar
extremo-a-extremo sin código Enterprise. Enterprise es **aditivo**, nunca sustractivo.

## Pilares de funcionalidades

> Listo = funciona end-to-end hoy. En construcción = desarrollo activo para 0.3.
> Planeado = en el roadmap (0.4+).

| Pilar | Estado |
|-------|--------|
| **Activos** | **Listo:** schema core, Categorías, Fabricantes, Modelos, prefijo de tag, campos vehiculares. **Planeado (0.4+):** Custom Fields & Fieldsets, Proveedores, Depreciación, Status Labels, Aceptación/EULA. |
| **Reservas** | **Listo:** reserva con antelación + workflow de aprobación, carrito (multi-activo), blackouts, detección de conflicto bajo `FOR UPDATE` SERIALIZABLE. **En construcción:** UI de gestión de blackouts, sweep de detección de atraso + señal en UI. **Planeado (0.4+):** reservas recurrentes, gating de compliance de capacitación, matrices de aprobación configurables. |
| **Inspecciones** | **Listo:** templates configurables (por tenant), evidencia fotográfica con strip de EXIF, versionado de ítems vía snapshot, workflow FAIL-review, sweep de retención de fotos. **Planeado (0.4+):** captura de firma, offline-first en móvil, comparación antes/después. |
| **Mantenimiento** | **En construcción:** apertura/listado/cierre manual de ticket + flip de estado del activo. **Planeado (0.4+):** auto-sugerencia desde inspección FAIL o flag de damage, alertas predictivas por KM/tiempo, portal del proveedor. |
| **Personas** | **Listo:** Usuarios, TenantMembership con role + status, OIDC + auth e-mail/contraseña, flujo de invitación. **Planeado (0.4+):** SCIM 2.0, mapeo de grupo vía IdP. SAML/LDAP fuera del roadmap pre-1.0. |
| **Multi-tenancy** | **Listo:** Postgres RLS en la capa de query, GUC `panorama.current_tenant` enforced vía `runInTenant`, FORCE RLS en cada tabla scoped por tenant, trigger de FK cross-tenant. |
| **Autenticación** | **Listo:** OIDC (Google + Microsoft Entra) con gate `email_verified` + override Workspace `hd`, e-mail/contraseña con argon2id, Personal Access Tokens. **Planeado (0.4+):** SAML, WebAuthn. |
| **Notificaciones** | **Listo:** event bus interno (`panorama.*.*`), registry de canal por evento, audit hash-chained de manipulación, canal de e-mail de invitación. **Planeado (0.4+):** conectores Slack/Teams/PagerDuty, entrega por webhook con HMAC, e-mails de ciclo de vida de reserva. |
| **Reportes** | **Planeado (0.4+):** guardar-como-vista, programar, enviar por mail; export CSV/XLSX/PDF. Nada listo hoy. |
| **Etiquetas/Códigos** | **Planeado (0.4+):** renderizado SVG en servidor, plantillas por tenant. Nada listo hoy. |
| **Importadores** | **Listo:** CSV importer + CLI `panorama-migrator` con adapters para sistemas upstream de TI/flota. |
| **API** | **Listo:** REST bajo NestJS, OpenAPI tipado auto-generado, shim de compatibilidad autenticado por PAT para clientes legacy de TI. **Planeado (0.4+):** webhooks con HMAC. GraphQL **no** está en el roadmap. |
| **Observabilidad** | **Listo:** logs JSON estructurados vía Pino, audit hash chain, threshold de coverage de vitest. **Planeado (0.4+):** trazas OpenTelemetry, métricas Prometheus. |
| **i18n** | **Listo:** framework EN/PT-BR/ES + gate de CI (cada clave debe existir en los tres locales). **En construcción:** ~80% de las strings web aún hardcoded en inglés; migración a UI completamente traducida ocurre durante prep del pilot. |

## Arquitectura en una pantalla

```
+--------------------+     +--------------------+     +-----------------+
| apps/web (Next.js) |     | apps/admin (Next.js)|    | apps/mobile (RN)|
+---------+----------+     +---------+----------+     +--------+--------+
          |                           |                         |
          +-------- REST + webhooks, sesión OIDC ----------------+
                                    |
                       +------------v-------------+
                       |   apps/core-api (NestJS) |
                       |   módulos de dominio +    |
                       |   ciclo de vida de plugin |
                       +------------+-------------+
                                    |
      +-----------+------------+----+---------+-----------------+
      |           |            |              |                 |
   Postgres    Redis       Object Store    OpenSearch       Event bus
   (Prisma)   (caché,      (fotos,         (full-text        (NATS JetStream
              colas vía     uploads,         opcional)         o Redpanda)
              BullMQ)       backups)
```

Topologías de despliegue:

- **Docker Compose en un nodo** — listo para usar; equipo pequeño / hobby
- **Kubernetes + Helm** — `infra/helm/panorama`; capa web + worker horizontal, Postgres gestionado
- **Blueprints Terraform** para Postgres + object storage gestionado en AWS/GCP/Azure

Ver [`docs/adr/0001-stack-choice.md`](./docs/adr/0001-stack-choice.md) para el porqué del
NestJS + Next.js + Postgres + Prisma, y [`docs/es/arquitectura.md`](./docs/es/arquitectura.md)
para el texto completo.

## Licencia

La edición Community es **AGPL-3.0-or-later**. La cláusula AGPL es intencional — quien
ejecute una SaaS basada en Panorama debe compartir sus modificaciones. Los módulos
Enterprise viven en un repo privado separado, bajo licencia comercial.

Ver [LICENSE](./LICENSE) y [docs/es/licenciamiento.md](./docs/es/licenciamiento.md).

## Créditos

- Atribución de la cadena de fork por obligación AGPL — ver [README.md](./README.md) sección Credits.
- Agradecimientos a los proyectos OSS que usamos — ver `THIRD_PARTY_NOTICES.md` al momento del release.
