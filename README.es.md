# Panorama

> Plataforma open-source unificada para **gestión de activos de TI + gestión operativa de flota**.
> Sucesor de ejecutar [Snipe-IT](https://snipeitapp.com) junto con un overlay de reservas a medida —
> un solo sistema, trilingüe, auto-hospedable, API-first.

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

Hoy, las flotas que también manejan inventario de TI terminan cosiendo dos sistemas:

- **Snipe-IT** (Laravel, AGPL-3.0) — excelente para TI, débil en reservas con antelación, débil en campos específicos de vehículo
- **Un overlay hecho a medida** como [SnipeScheduler-FleetManager](https://github.com/VitorMRodovalho/SnipeScheduler-FleetManager) — atornillado sobre Snipe-IT para reservas, inspecciones, capacitación del conductor, particionado multi-entidad

Correr los dos significa: dos bases de datos, dos superficies de autenticación, dos
pistas de auditoría, usuarios duplicados, dos caminos de upgrade y una frontera HTTP
frágil entre ambos. Panorama absorbe ambos conjuntos de funcionalidades en un solo modelo
de dominio, un solo plano de datos y una sola superficie de administración.

## Estado

🚧 **Pre-alpha — greenfield.** Inicio 2026-04-17. Arquitectura y nombre abiertos a revisión.
Ver [`docs/adr/`](./docs/adr/) para las decisiones registradas hasta hoy.

## Ediciones

| Edición       | Licencia      | Código     | Caso de uso                                                          |
|---------------|---------------|------------|----------------------------------------------------------------------|
| **Community** | AGPL-3.0      | Este repo  | Auto-hospedaje completo para cualquier tamaño, sin feature gating en el core |
| **Enterprise**| Comercial     | Repositorio privado `panorama-enterprise` (tomado en build time) | Conectores SSO especializados, paquetes de auditoría SOC-2, white-label, soporte 24×7 |
| **Cloud**     | SaaS gestionado | Operado por nosotros | Onboarding rápido, Postgres + backups + parches a nuestra cuenta |

La edición **Community** es la implementación de referencia — todo en ella debe funcionar
extremo-a-extremo sin código Enterprise. Enterprise es **aditivo**, nunca sustractivo.

## Pilares de funcionalidades

| Pilar | De Snipe-IT mantenemos | De FleetManager mantenemos | Panorama añade |
|-------|------------------------|-----------------------------|----------------|
| **Activos** | Hardware/Licencia/Accesorio/Consumible/Componente/Kits, Categorías, Fabricantes, Modelos, Proveedores, Estados, Campos/Fieldsets personalizados, Eventos de ciclo de vida, Depreciación, Aceptación/EULA | Modelo vehículo-first, validación de VIN/placa duplicada, prefijo de etiqueta por empresa | Abstracción `assetable` unificada: cualquier tipo de activo puede ser reservable |
| **Reservas** | — | Reserva con antelación + workflow de aprobación, reservas recurrentes, blackouts, exigencia de capacitación, auto-aprobación VIP, carrito multi-activo | Calendario de primera clase, detección de conflicto con `FOR UPDATE`, matrices de aprobación configurables |
| **Inspecciones** | — | Checklist configurable (Quick 4 / Full 50 ítems / Off), foto, strip de EXIF, comparación antes/después | Checklists arbitrarios por tipo de activo, captura de firma, offline-first en móvil |
| **Mantenimiento** | Mantenimientos de activo | Flag al devolver, alertas por KM/tiempo | Alertas predictivas, calendarios por tipo, portal de proveedor |
| **Personas** | Usuarios, Grupos, Departamentos, Ubicaciones, Empresas, Permisos | Validez de capacitación del conductor, sync OAuth por e-mail | SCIM 2.0, mapeo de grupo vía IdP, matriz RBAC por empresa |
| **Multi-tenancy**| Empresas (row-level), flag de permiso por empresa | Filtrado por empresa en vehículos/reservas | Tenancy estricto a nivel de consulta + claves de caché tenant-aware |
| **Autenticación**| LDAP, SAML, OAuth Google/Microsoft, tokens API Passport, 2FA | OAuth para web, token para CLI | OIDC, SAML, provisioning SCIM, mapeo de grupo por IdP, WebAuthn, API keys de corta duración |
| **Notificaciones**| E-mail, Slack, Teams, Google Chat | SMTP + Teams por evento, recordatorios de atraso, expiración de capacitación | Webhooks, PagerDuty, event bus configurable (`panorama.asset.checked_out`), entrega por cola |
| **Reportes**| 20+ reportes nativos, exportación CSV | Utilización, compliance, analítica de conductor | ReportTemplate 2.0: guardar-como-vista, programar, enviar por mail; export CSV/XLSX/PDF |
| **Etiquetas/Códigos**| PDFs QR + 1D vía TCPDF | — | Renderizado SVG en servidor, plantillas por tenant |
| **Importadores**| CSV para toda entidad principal | — | CSV idempotente con preview dry-run, CLI `panorama migrate-from-snipeit` |
| **API**| REST v1 (1.379 rutas), tokens OAuth 2 Passport | — | REST + OpenAPI 3.1 tipado, GraphQL opcional, webhooks con firma HMAC |
| **Observabilidad**| Log de actividad, backups Spatie | Log de actividad, monitor de salud de CRON | Trazas OpenTelemetry, métricas Prometheus, logs JSON estructurados |
| **i18n**| 50+ traducciones de la comunidad | Solo inglés | EN / PT-BR / ES de primera clase, framework para añadir más idiomas |

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

- Derivado del trabajo en [SnipeScheduler-FleetManager](https://github.com/VitorMRodovalho/SnipeScheduler-FleetManager) por Vitor Rodovalho, a su vez un fork de [SnipeScheduler](https://github.com/JSY-Ben/SnipeScheduler) de Ben Pirozzolo.
- Cobertura de funcionalidades mapeada contra [Snipe-IT](https://github.com/grokability/snipe-it) (AGPL-3.0, © Grokability Inc.).
