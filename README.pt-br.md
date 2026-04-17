# Panorama

> Plataforma open-source unificada para **gestão de ativos de TI + gestão operacional de frota**.
> O sucessor de rodar [Snipe-IT](https://snipeitapp.com) junto com um overlay de agendamento
> feito à mão — um sistema só, trilíngue, auto-hospedável, API-first.

<p align="center">
  <em>Um único painel para notebooks, licenças, celulares, empilhadeiras, vans — e tudo no meio do caminho.</em>
</p>

---

## 🌐 Leia em outro idioma

- **English** — [README.md](./README.md)
- **Português (Brasil)** — você está aqui
- **Español** — [README.es.md](./README.es.md)

---

## Por que Panorama?

Hoje, frotas que também têm inventário de TI acabam costurando dois sistemas:

- **Snipe-IT** (Laravel, AGPL-3.0) — excelente para TI, fraco em reservas agendadas, fraco em campos específicos de veículo
- **Um overlay customizado** como o [SnipeScheduler-FleetManager](https://github.com/VitorMRodovalho/SnipeScheduler-FleetManager) — parafusado em cima do Snipe-IT para lidar com reservas, inspeções, treinamento de motorista, particionamento multi-entidade

Rodar os dois significa: dois bancos, duas superfícies de autenticação, duas trilhas de
auditoria, usuários duplicados, dois caminhos de upgrade e uma fronteira HTTP frágil entre
eles. O Panorama absorve ambos os conjuntos de funcionalidades em um único modelo de domínio,
um único plano de dados e uma única superfície de administração.

## Situação

🚧 **Pré-alpha — greenfield.** Iniciado em 2026-04-17. Arquitetura e nome abertos à revisão.
Veja [`docs/adr/`](./docs/adr/) para as decisões já registradas.

## Edições

| Edição       | Licença       | Código     | Caso de uso                                                          |
|--------------|---------------|------------|----------------------------------------------------------------------|
| **Community**| AGPL-3.0      | Este repo  | Auto-hospedagem completa para qualquer tamanho, sem feature gating no core |
| **Enterprise**| Comercial    | Repositório privado `panorama-enterprise` (puxado no build) | Conectores SSO especializados, pacotes de auditoria SOC-2, white-label, suporte 24×7 |
| **Cloud**    | SaaS gerenciado | Operado por nós | Onboarding mais rápido, Postgres + backups + patching por nossa conta |

A edição **Community** é a implementação de referência — tudo nela tem que funcionar
ponta-a-ponta sem código Enterprise. Enterprise é **aditivo**, nunca subtrativo.

## Pilares de funcionalidades

| Pilar | Do Snipe-IT preservamos | Do FleetManager preservamos | Panorama adiciona |
|-------|-------------------------|------------------------------|-------------------|
| **Ativos** | Hardware/Licença/Acessório/Consumível/Componente/Kits, Categorias, Fabricantes, Modelos, Fornecedores, Status, Campos/Fieldsets Customizados, Eventos de ciclo de vida, Depreciação, Aceite/EULA | Modelo veículo-first, validação de VIN/placa duplicada, prefixo de tag por empresa | Abstração `assetable` unificada: qualquer tipo de ativo pode ser reservável |
| **Reservas**| — | Reserva com antecedência + workflow de aprovação, reservas recorrentes, blackouts, exigência de treinamento, auto-aprovação VIP, cesta multi-ativos | Experiência de calendário de primeira classe, detecção de conflito com `FOR UPDATE`, matrizes de aprovação configuráveis |
| **Inspeções**| — | Checklist configurável (Quick 4 / Full 50 itens / Off), foto, strip de EXIF, comparação antes/depois | Checklists arbitrários por tipo de ativo, captura de assinatura, offline-first no mobile |
| **Manutenção**| Manutenções de ativo | Flag de manutenção na devolução, alertas por KM/tempo | Alertas preditivos, cronogramas por tipo, portal do fornecedor |
| **Pessoas**| Usuários, Grupos, Departamentos, Locais, Empresas, Permissões | Validade de treinamento do motorista, sincronização OAuth por e-mail | SCIM 2.0, mapeamento de grupo via IdP, matriz RBAC por empresa |
| **Multi-tenancy**| Empresas (row-level), flag de permissão por empresa | Filtragem por empresa nos veículos/reservas | Tenancy estrito no nível da query + chaves de cache tenant-aware |
| **Autenticação**| LDAP, SAML, OAuth Google/Microsoft, tokens de API Passport, 2FA | OAuth para web, token para CLI | OIDC, SAML, provisionamento SCIM, mapeamento de grupo por IdP, WebAuthn, API keys de curta duração |
| **Notificações**| E-mail, Slack, Teams, Google Chat | SMTP + Teams por evento, lembretes de atraso, expiração de treinamento | Webhooks, PagerDuty, event bus configurável (`panorama.asset.checked_out`), entrega via fila |
| **Relatórios**| 20+ relatórios nativos, export CSV | Utilização, compliance, analytics de motorista | ReportTemplate 2.0: salvar-como-view, agendar, enviar por e-mail; export CSV/XLSX/PDF |
| **Labels/Códigos**| PDFs QR + 1D via TCPDF | — | Renderização SVG no servidor, templates por tenant |
| **Importadores**| CSV para toda entidade principal | — | CSV idempotente com preview dry-run, CLI `panorama migrate-from-snipeit` |
| **API**| REST v1 (1.379 rotas), tokens OAuth 2 Passport | — | REST + OpenAPI 3.1 tipado, GraphQL opcional, webhooks com assinatura HMAC |
| **Observabilidade**| Log de atividade, backups Spatie | Log de atividade, monitor de saúde do CRON | Tracing OpenTelemetry, métricas Prometheus, logs JSON estruturados |
| **i18n**| 50+ traduções da comunidade | Só inglês | EN / PT-BR / ES de primeira classe, framework para contribuir com mais idiomas |

## Arquitetura em uma tela

```
+--------------------+     +--------------------+     +-----------------+
| apps/web (Next.js) |     | apps/admin (Next.js)|    | apps/mobile (RN)|
+---------+----------+     +---------+----------+     +--------+--------+
          |                           |                         |
          +------------ REST + webhooks, sessão OIDC ------------+
                                    |
                       +------------v-------------+
                       |   apps/core-api (NestJS) |
                       |  módulos de domínio +     |
                       |   ciclo de vida de plugin |
                       +------------+-------------+
                                    |
      +-----------+------------+----+---------+-----------------+
      |           |            |              |                 |
   Postgres    Redis       Object Store    OpenSearch       Event bus
   (Prisma)   (cache,      (fotos,         (full-text        (NATS JetStream
              filas via     uploads,         opcional)         ou Redpanda)
              BullMQ)       backups)
```

Topologias de deploy:

- **Docker Compose em um nó** — pronto para uso; time pequeno / hobby
- **Kubernetes + Helm** — `infra/helm/panorama`; camada web + worker horizontal, Postgres gerenciado
- **Blueprints Terraform** para Postgres + object storage gerenciado em AWS/GCP/Azure

Veja [`docs/adr/0001-stack-choice.md`](./docs/adr/0001-stack-choice.md) para o porquê do
NestJS + Next.js + Postgres + Prisma, e [`docs/pt-br/arquitetura.md`](./docs/pt-br/arquitetura.md)
para o texto completo.

## Licença

A edição Community é **AGPL-3.0-or-later**. A cláusula AGPL é proposital — quem roda
uma SaaS hospedada baseada no Panorama tem que compartilhar as modificações. Os módulos
Enterprise ficam em repositório privado separado, sob licença comercial.

Veja [LICENSE](./LICENSE) e [docs/pt-br/licenciamento.md](./docs/pt-br/licenciamento.md).

## Créditos

- Derivado de trabalho no [SnipeScheduler-FleetManager](https://github.com/VitorMRodovalho/SnipeScheduler-FleetManager) por Vitor Rodovalho, por sua vez um fork do [SnipeScheduler](https://github.com/JSY-Ben/SnipeScheduler) do Ben Pirozzolo.
- Cobertura de funcionalidades mapeada contra o [Snipe-IT](https://github.com/grokability/snipe-it) (AGPL-3.0, © Grokability Inc.).
