# Panorama

> Uma plataforma open-source para **ativos de TI + frota operacional** — notebooks, veículos, licenças, equipamentos, em um único painel.
> Postgres RLS multi-tenant, OIDC, trilha de auditoria com hash-chain, trilíngue EN/PT-BR/ES.
> AGPL-3.0 (fork-friendly). Preview hospedado gratuito chegando.

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

Times que gerenciam tanto ativos de TI (notebooks, licenças, celulares) quanto equipamento
operacional (veículos, empilhadeiras, ferramentas) acabam rodando dois sistemas separados —
dois bancos, duas superfícies de autenticação, duas trilhas de auditoria, usuários duplicados
e uma integração frágil entre eles.

O Panorama é uma plataforma só pra ambos. Modelo de domínio único, plano de dados único,
superfície de admin única. Multi-tenant por construção (Postgres RLS forçado em cada tabela
escopada por tenant). Auditoria hash-chained, com detecção de adulteração. UI trilíngue desde
o dia 1 (EN/PT-BR/ES). Auto-hospede ou use o preview hospedado.

## Situação

🚧 **Acesso antecipado — aberto pra uso, contém arestas.** Iniciado em 2026-04-17.

- **Backend:** pronto pra produção (NestJS 11 + Prisma 6 + Postgres RLS + OIDC testado
  end-to-end via [#92](https://github.com/VitorMRodovalho/panorama/issues/92)). Dependências
  atualizadas até 2026-05-09 ([#123](https://github.com/VitorMRodovalho/panorama/issues/123)).
- **App web:** em construção ativa. ~10% da superfície de funcionalidades hoje; navegação +
  CRUD de ativos + formulários de checkout em andamento
  ([#52](https://github.com/VitorMRodovalho/panorama/issues/52)).
- **Preview hospedado:** abre quando a [Wave 0 readiness](./docs/audits/HANDOFF-2026-05-09-session-end.md)
  fechar (Privacy + ToS + status page + fix da audit chain + endpoint de export de dados).

Decisões de arquitetura em [`docs/adr/`](./docs/adr/); estado atual + plano de ondas em
[`docs/audits/HANDOFF-2026-05-09-session-end.md`](./docs/audits/HANDOFF-2026-05-09-session-end.md).

## Edições

| Edição       | Licença       | Código     | Caso de uso                                                          |
|--------------|---------------|------------|----------------------------------------------------------------------|
| **Community**| AGPL-3.0      | Este repo  | Auto-hospedagem completa para qualquer tamanho, sem feature gating no core |
| **Enterprise**| Comercial    | Repositório privado `panorama-enterprise` (puxado no build) | Conectores SSO especializados, pacotes de auditoria SOC-2, white-label, suporte 24×7 |
| **Preview hospedado** | Gratuito (acesso antecipado) | Operado por nós | Instância hospedada gratuita pra avaliação; abre quando a Wave 0 readiness fechar (ver handoff) |

A edição **Community** é a implementação de referência — tudo nela tem que funcionar
ponta-a-ponta sem código Enterprise. Enterprise é **aditivo**, nunca subtrativo.

## Pilares de funcionalidades

> Pronto = funciona ponta-a-ponta hoje. Em construção = desenvolvimento ativo pra 0.3.
> Planejado = no roadmap (0.4+).

| Pilar | Estado |
|-------|--------|
| **Ativos** | **Pronto:** schema core, Categorias, Fabricantes, Modelos, prefixo de tag, campos veiculares. **Planejado (0.4+):** Custom Fields & Fieldsets, Fornecedores, Depreciação, Status Labels, Aceite/EULA. |
| **Reservas** | **Pronto:** reserva com antecedência + workflow de aprovação, cesta (multi-ativos), blackouts, detecção de conflito sob `FOR UPDATE` SERIALIZABLE. **Em construção:** UI de gestão de blackouts, sweep de detecção de atraso + sinal na UI. **Planejado (0.4+):** reservas recorrentes, gating de compliance de treinamento, matrizes de aprovação configuráveis. |
| **Inspeções** | **Pronto:** templates configuráveis (por tenant), evidência fotográfica com strip de EXIF, versionamento de itens via snapshot, workflow FAIL-review, sweep de retenção de fotos. **Planejado (0.4+):** captura de assinatura, offline-first no mobile, comparação antes/depois. |
| **Manutenção** | **Em construção:** abertura/listagem/fechamento manual de ticket + flip de status do ativo. **Planejado (0.4+):** auto-sugestão a partir de inspeção FAIL ou flag de damage, alertas preditivos por KM/tempo, portal do fornecedor. |
| **Pessoas** | **Pronto:** Usuários, TenantMembership com role + status, OIDC + auth e-mail/senha, fluxo de convite. **Planejado (0.4+):** SCIM 2.0, mapeamento de grupo via IdP. SAML/LDAP fora do roadmap pré-1.0. |
| **Multi-tenancy** | **Pronto:** Postgres RLS na camada de query, GUC `panorama.current_tenant` enforced via `runInTenant`, FORCE RLS em cada tabela escopada por tenant, trigger de FK cross-tenant. |
| **Autenticação** | **Pronto:** OIDC (Google + Microsoft Entra) com gate `email_verified` + override Workspace `hd`, e-mail/senha com argon2id, Personal Access Tokens. **Planejado (0.4+):** SAML, WebAuthn. |
| **Notificações** | **Pronto:** event bus interno (`panorama.*.*`), registry de canal por evento, audit hash-chained de adulteração, canal de e-mail de convite. **Planejado (0.4+):** conectores Slack/Teams/PagerDuty, entrega via webhook com HMAC, e-mails de ciclo de vida de reserva. |
| **Relatórios** | **Planejado (0.4+):** salvar-como-view, agendar, enviar por e-mail; export CSV/XLSX/PDF. Nada pronto hoje. |
| **Labels/Códigos** | **Planejado (0.4+):** renderização SVG no servidor, templates por tenant. Nada pronto hoje. |
| **Importadores** | **Pronto:** CSV importer + CLI `panorama-migrator` com adapters pra sistemas upstream de TI/frota. |
| **API** | **Pronto:** REST sob NestJS, OpenAPI tipado auto-gerado, shim de compatibilidade autenticado por PAT pra clientes legados de TI. **Planejado (0.4+):** webhooks com HMAC. GraphQL **não** está no roadmap. |
| **Observabilidade** | **Pronto:** logs JSON estruturados via Pino, audit hash chain, threshold de coverage do vitest. **Planejado (0.4+):** tracing OpenTelemetry, métricas Prometheus. |
| **i18n** | **Pronto:** framework EN/PT-BR/ES + gate de CI (cada chave precisa existir nos três locais). **Em construção:** ~80% das strings web ainda hardcoded em inglês; migração pra UI totalmente traduzida acontece durante a prep do pilot. |

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

- Atribuição da cadeia de fork por obrigação AGPL — ver [README.md](./README.md) seção Credits.
- Agradecimentos aos projetos OSS que usamos — ver `THIRD_PARTY_NOTICES.md` no momento do release.
