/**
 * Plain-language Privacy Policy content, per locale.
 *
 * Wave 0 §9 plain-language v1 draft — covers LGPD Art. 9 mandatories
 * + names sub-processor CATEGORIES (not vendors, per security-reviewer
 * C2 threat-model reasoning). Final language pending counsel review.
 *
 * Last updated: 2026-05-18. The page exposes this date to readers via
 * `LAST_UPDATED_ISO`.
 *
 * Per the i18n CI gate, all three locale keys must exist. EN is the
 * canonical pre-counsel draft. PT-BR is a parallel draft (the home
 * regulatory regime is LGPD/Brazil; pt-br is the load-bearing
 * translation). ES is a placeholder + pointer to the EN canon until
 * counsel review covers all three.
 */

export const LAST_UPDATED_ISO = '2026-05-18';

export const PRIVACY_CONTENT = {
  en: `
This Privacy Policy explains what data Panorama collects, why we collect
it, with whom we share it (in categories — never named vendors), and
what rights you have over it. We try to write it in plain language so
you do not need a lawyer to read it. The official mandatory headings
under Brazilian LGPD (Lei Geral de Proteção de Dados, Art. 9) are
covered below in the order LGPD prescribes.

## Who is the controller?

For the **hosted Panorama instance** at panorama.vitormr.dev (and any
future panorama.app deployment by the same maintainer): the controller
is the individual maintainer of the Panorama project, contactable at
vitor@vitormr.dev.

For **self-hosted Panorama deployments** (every Panorama instance you
or a third party runs on your own infrastructure under the AGPL
licence): the controller is the operator of that deployment, not the
Panorama project maintainer. This Privacy Policy describes what
Panorama is BUILT to do; the operator of your deployment decides
exactly how it is used and is responsible for their own privacy
notice to their data subjects.

If you are unsure whether you are using the hosted instance or a
self-hosted deployment, look at the URL in your browser. Anything
other than the addresses listed above is self-hosted.

## What we collect

The data Panorama processes is the data needed to operate a multi-
tenant fleet and asset management service. In the hosted instance
this includes:

- **Account data**: name, email address, organisation slug, role
  within your tenant, and your chosen interface language.
- **Authentication data**: a hashed session token, OIDC subject
  identifier (when you log in via Google or Microsoft), and
  per-request correlation identifiers (added in Round 6 audit work).
- **Operational data**: the records you create or that are created
  on your behalf — assets, reservations, inspections, maintenance
  tickets, photos uploaded as inspection evidence, comments, audit
  events. This is the working dataset of your fleet operations.
- **Technical telemetry**: HTTP request metadata, IP address (for
  rate-limiting and abuse detection only — not retained for
  analytics), user-agent string, and structured server logs.

We do not run third-party analytics scripts. There is no Google
Analytics, no Mixpanel, no Hotjar, no Facebook Pixel in the hosted
instance. We do not sell, rent, or syndicate your data to
advertisers.

## Why we collect it

Each data class has a single specific purpose:

- **Account data** — to identify you and the tenant you belong to,
  and to enforce that you can only see your own tenant's records
  (the multi-tenant isolation contract).
- **Authentication data** — to keep you signed in across requests
  and to detect anomalies (rotation, password breach, OIDC issuer
  mismatch).
- **Operational data** — to provide the fleet management service
  you signed up for. Every record you create exists because you or
  another user in your tenant created it for a specific operational
  purpose.
- **Technical telemetry** — to keep the service available (rate-
  limiting), to debug operator errors (request-id correlation in
  audit + log streams), and to detect attacks (failed login spikes,
  audit-chain tamper signals).

Under LGPD Art. 7, our legal bases for processing are: (a) the
contract with you to provide the service (Art. 7 V), (b) our
legitimate interest in keeping the service secure and operational
(Art. 7 IX), and (c) for some specific categories, your explicit
consent (Art. 7 I — applicable when you opt into optional features).

## How long we keep it

- **Account + authentication data**: while your account is active.
  When you delete your account or your tenant, see "Your rights"
  below for the deletion path.
- **Operational data**: while your tenant exists. We never
  pro-actively delete operational data; the tenant owner controls
  retention.
- **Audit log**: forever, for as long as the tenant exists. The
  audit log is append-only and hash-chained for tamper-evidence —
  it is the legal record of what happened in your tenant.
- **Technical telemetry**: HTTP server logs are retained for 30
  days. Audit events created from telemetry (rate-limit trips,
  failed logins) follow the audit-log retention above.
- **Tenant export tarballs**: created by you on demand, retained
  for 24 hours, then automatically deleted from object storage.

## Who we share it with — sub-processor categories

We use the following categories of third-party services to operate
the hosted Panorama instance. We name CATEGORIES, not specific
vendors, by design — this reduces the attack surface against the
operator's vendor relationships. The maintainer can disclose the
specific vendor in a category to a tenant on request, under NDA, if
the tenant has a contractual or regulatory need for the specific
identity.

- **Cloud hosting (IaaS).** Where the Panorama runtime executes.
- **Managed Postgres.** Where the tenant database lives.
- **Object storage (S3-compatible).** Where uploaded photos and
  tenant-export tarballs are stored.
- **Email delivery (SMTP).** Where transactional emails
  (invitations, notifications) are sent through.
- **OIDC identity providers.** Google + Microsoft — only when you
  choose to sign in via one of them. They learn that you signed
  into Panorama; they do not see your operational data.
- **Error monitoring (opt-in).** If the operator has configured
  Sentry, server-side errors include a stack trace and request-id.
  Tenant data is NOT included in error payloads by design; the
  Sentry integration is configured to redact PII per ADR-0018.
- **CAPTCHA (signup-only).** When the operator enables self-serve
  signup, Cloudflare Turnstile is consulted at the signup form to
  block bots. They see the signup attempt; they do not see your
  operational data.

We do NOT use third-party advertising or analytics services.

For self-hosted deployments, this list does not apply — your
operator chooses their own infrastructure providers and is
responsible for disclosing them to their tenants.

## How we protect it

- **Multi-tenant isolation** is enforced at the database layer via
  PostgreSQL row-level security (RLS), not just in application code.
  A bug in the application code cannot cause one tenant's query to
  return another tenant's rows.
- **Encryption in transit** — every connection to the hosted
  instance uses HTTPS / TLS. We do not accept HTTP traffic.
- **Encryption at rest** — your database and object storage are
  encrypted at rest by the cloud-hosting and managed-Postgres
  providers.
- **Tamper-evident audit log** — every administrative or operational
  action is recorded in a SHA-256 hash-chained audit log. Any
  modification to a past event breaks the chain at the next
  verification check.
- **Backups + restore drills** — the audit log and operational
  data are backed up by the managed-Postgres provider; the
  maintainer exercises restore drills on a documented cadence
  (\`docs/runbooks/restore.md\`).

## Your rights under LGPD Art. 18

You have the following rights with respect to your data. Any
request can be sent to vitor@vitormr.dev. We respond within 15
days unless we need more time, in which case we tell you why.

1. **Access**. You can ask what data we have about you. You can
   also generate a tenant-export tarball from inside the
   application (Settings → Export tenant data) to download a copy
   of your tenant's operational data.
2. **Correction**. You can update most data fields directly in
   the application. For data you cannot edit (e.g., audit events,
   which are immutable by design), email us to request a correction
   note appended to the record.
3. **Deletion**. You can delete your tenant from Settings → Delete
   tenant. Deletion is irreversible after a 7-day grace period;
   tenant-data is purged from the database, audit log entries about
   the deletion itself are retained for legal record.
4. **Portability**. The tenant export above is a structured JSON
   archive of all your tenant's data; that is the portable format.
5. **Information about who we share with**. See the sub-processor
   categories above. We can disclose the specific vendor under NDA
   for a contractual or regulatory need.
6. **Withdrawal of consent**. Where processing is based on consent
   (rare; most processing is contract-necessary), you can withdraw
   consent in the application or by email.
7. **Objection** to processing that is based on legitimate interest
   only. Note that objecting to security telemetry processing
   typically means the account cannot continue operating.
8. **Information about the legal basis** of any processing — see
   "Why we collect it" above; ask if anything is unclear.

For data-subject requests where we cannot verify your identity
through your account (e.g., a closed account), we will ask for
additional identity verification before responding.

## Children

Panorama is built for fleet operations — it is not directed at
children under 18. We do not knowingly collect data about people
under 18. If a tenant operator creates accounts for users under
18 (for example, in a youth-organisation transport setting), the
operator is the controller of that data and is responsible for
parental consent under their local law.

## Cookies and similar technologies

We use two strictly-necessary cookies in the hosted instance:

- A **session cookie** (\`panorama_session\`) — encrypted with a
  rotating key, lasts 7 days, refreshes on use. Required for you
  to stay signed in.
- A **locale cookie** (\`panorama_locale\`) — stores your interface-
  language preference. Set when you change languages.

We do not use any analytics, marketing, or tracking cookies.

## International transfers

The hosted Panorama instance runs in the region you select at
sign-up time. We do not transfer your data to a different region
without your consent. The maintainer is based in Brazil; data
transferred to providers outside Brazil is subject to LGPD Art. 33
(adequacy decisions or standard contractual clauses); the specific
vendor disclosure includes the data residency for each category.

## Changes to this policy

When this policy changes, we will notify the email address on
your account at least 30 days before the change takes effect.
The current version date is shown at the top of the page. Previous
versions are tracked in the public Panorama repository's git
history at github.com/VitorMRodovalho/panorama.

## Contact

For any privacy-related question, complaint, or data-subject
request: vitor@vitormr.dev.

Our LGPD data-protection officer (DPO / encarregado) function is
currently performed by the same maintainer. When the hosted
instance has paying tenants and a separate DPO is appointed, this
section will name them. The reporter email at
vitor@vitormr.dev is monitored either way.

You may also contact the Brazilian data-protection authority
(ANPD) at gov.br/anpd if you believe we have not handled your
request adequately.

---

**Status notice (this draft).** This is the plain-language v1
draft per Round 7 of the Wave 0 acceptance plan. The maintainer
will engage qualified legal counsel before the hosted Panorama
URL is announced publicly to a paying audience. The policy text
may change as a result of counsel review; the change-notice
above (30-day window) applies to any post-counsel revision.
`,

  'pt-br': `
Esta Política de Privacidade explica quais dados a Panorama coleta,
por que coletamos, com quem compartilhamos (em categorias — nunca
fornecedores nomeados) e quais direitos você tem sobre eles.
Tentamos escrever em linguagem clara para que você não precise de
advogado para entender. Os títulos obrigatórios sob a LGPD (Lei
Geral de Proteção de Dados, Art. 9) estão cobertos abaixo na ordem
prescrita pela LGPD.

## Quem é o controlador?

Para a **instância hospedada da Panorama** em panorama.vitormr.dev
(e qualquer futura implantação em panorama.app pelo mesmo
mantenedor): o controlador é o mantenedor individual do projeto
Panorama, contato em vitor@vitormr.dev.

Para **implantações auto-hospedadas da Panorama** (qualquer
instância da Panorama que você ou terceiros executem em
infraestrutura própria sob a licença AGPL): o controlador é o
operador dessa implantação, não o mantenedor do projeto Panorama.
Esta Política de Privacidade descreve o que a Panorama é PROJETADA
para fazer; o operador da sua implantação decide exatamente como
ela é usada e é responsável pelo próprio aviso de privacidade aos
seus titulares de dados.

Se não souber se está usando a instância hospedada ou uma
implantação auto-hospedada, veja a URL no seu navegador. Qualquer
endereço diferente dos listados acima é auto-hospedado.

## O que coletamos

Os dados que a Panorama processa são aqueles necessários para
operar um serviço multi-tenant de gestão de frota e ativos. Na
instância hospedada, isso inclui:

- **Dados de conta**: nome, e-mail, slug da organização, papel no
  seu tenant e idioma escolhido para a interface.
- **Dados de autenticação**: token de sessão com hash, identificador
  OIDC (quando você entra via Google ou Microsoft) e identificadores
  de correlação por requisição (Round 6 do plano de auditoria).
- **Dados operacionais**: os registros que você ou outros usuários
  do seu tenant criam — ativos, reservas, inspeções, chamados de
  manutenção, fotos enviadas como evidência de inspeção, comentários,
  eventos de auditoria. Este é o conjunto de dados de trabalho da
  sua operação de frota.
- **Telemetria técnica**: metadados de requisição HTTP, endereço IP
  (apenas para rate-limiting e detecção de abuso — não retido para
  analytics), string user-agent e logs estruturados do servidor.

Não executamos scripts de analytics de terceiros. Não há Google
Analytics, Mixpanel, Hotjar nem Facebook Pixel na instância
hospedada. Não vendemos, alugamos nem distribuímos seus dados para
anunciantes.

## Por que coletamos

Cada classe de dado tem uma finalidade específica única:

- **Dados de conta** — para identificar você e o tenant ao qual
  pertence, e para garantir que só veja registros do seu próprio
  tenant (contrato de isolamento multi-tenant).
- **Dados de autenticação** — para mantê-lo conectado entre
  requisições e detectar anomalias (rotação, vazamento de senha,
  divergência de emissor OIDC).
- **Dados operacionais** — para prover o serviço de gestão de frota
  que você contratou. Cada registro existe porque você ou outro
  usuário do tenant o criou para uma finalidade operacional
  específica.
- **Telemetria técnica** — para manter o serviço disponível
  (rate-limiting), depurar erros de operador (correlação por
  request-id em auditoria + logs) e detectar ataques (picos de
  login com falha, sinais de adulteração da cadeia de auditoria).

Sob a LGPD Art. 7, nossas bases legais de tratamento são: (a) o
contrato com você para prestar o serviço (Art. 7, V), (b) nosso
legítimo interesse em manter o serviço seguro e operacional (Art.
7, IX), e (c) para algumas categorias específicas, seu
consentimento explícito (Art. 7, I — aplicável quando opta por
recursos opcionais).

## Por quanto tempo guardamos

- **Dados de conta + autenticação**: enquanto sua conta estiver
  ativa. Quando você excluir sua conta ou seu tenant, veja "Seus
  direitos" abaixo para o caminho de exclusão.
- **Dados operacionais**: enquanto seu tenant existir. Nunca
  excluímos dados operacionais proativamente; o titular do tenant
  controla a retenção.
- **Log de auditoria**: para sempre, enquanto o tenant existir. O
  log de auditoria é apenas-anexo (append-only) e encadeado por
  hash para evidência de adulteração — é o registro legal do que
  aconteceu no seu tenant.
- **Telemetria técnica**: logs de servidor HTTP são retidos por 30
  dias. Eventos de auditoria criados a partir de telemetria
  (tentativas de rate-limit, logins com falha) seguem a retenção
  do log de auditoria acima.
- **Tarballs de exportação do tenant**: criados por você sob
  demanda, retidos por 24 horas, depois excluídos automaticamente
  do object storage.

## Com quem compartilhamos — categorias de sub-processadores

Usamos as seguintes categorias de serviços de terceiros para
operar a instância hospedada da Panorama. Nomeamos CATEGORIAS, não
fornecedores específicos, por design — isso reduz a superfície de
ataque contra as relações com fornecedores do operador. O
mantenedor pode revelar o fornecedor específico de uma categoria
a um tenant sob NDA, mediante necessidade contratual ou regulatória.

- **Hospedagem em nuvem (IaaS).** Onde o runtime Panorama executa.
- **Postgres gerenciado.** Onde o banco do tenant vive.
- **Object storage (compatível com S3).** Onde fotos enviadas e
  tarballs de exportação são armazenados.
- **Entrega de e-mail (SMTP).** Por onde e-mails transacionais
  (convites, notificações) são enviados.
- **Provedores de identidade OIDC.** Google + Microsoft — apenas
  quando você escolhe entrar via um deles. Eles sabem que você
  entrou na Panorama; não veem seus dados operacionais.
- **Monitoramento de erros (opt-in).** Se o operador configurou
  Sentry, erros do servidor incluem stack trace e request-id.
  Dados de tenant NÃO são incluídos em payloads de erro por design;
  a integração Sentry é configurada para redigir PII conforme
  ADR-0018.
- **CAPTCHA (apenas cadastro).** Quando o operador habilita
  cadastro self-serve, Cloudflare Turnstile é consultado no
  formulário para bloquear bots. Ele vê a tentativa de cadastro;
  não vê seus dados operacionais.

NÃO usamos serviços de publicidade ou analytics de terceiros.

Para implantações auto-hospedadas, esta lista não se aplica — seu
operador escolhe os provedores de infraestrutura próprios e é
responsável por divulgá-los aos seus tenants.

## Como protegemos

- **Isolamento multi-tenant** é aplicado na camada de banco via
  row-level security (RLS) do PostgreSQL, não apenas no código da
  aplicação. Um bug no código não pode fazer uma consulta de um
  tenant retornar linhas de outro tenant.
- **Criptografia em trânsito** — toda conexão com a instância
  hospedada usa HTTPS / TLS. Não aceitamos tráfego HTTP.
- **Criptografia em repouso** — seu banco e object storage são
  criptografados em repouso pelos provedores de nuvem.
- **Log de auditoria com evidência de adulteração** — toda ação
  administrativa ou operacional é registrada em um log com cadeia
  de hashes SHA-256. Qualquer modificação a um evento passado
  quebra a cadeia na próxima verificação.
- **Backups + drills de restauração** — log de auditoria e dados
  operacionais são backupeados pelo provedor de Postgres
  gerenciado; o mantenedor executa drills de restauração em
  cadência documentada (\`docs/runbooks/restore.md\`).

## Seus direitos sob a LGPD Art. 18

Você tem os seguintes direitos sobre seus dados. Qualquer pedido
pode ser enviado para vitor@vitormr.dev. Respondemos em até 15
dias, salvo se precisarmos de mais tempo — nesse caso explicamos
por quê.

1. **Acesso**. Você pode perguntar quais dados temos sobre você.
   Também pode gerar um tarball de exportação do tenant dentro do
   aplicativo (Configurações → Exportar dados do tenant) para
   baixar uma cópia dos dados operacionais do seu tenant.
2. **Correção**. Você pode atualizar a maioria dos campos
   diretamente no aplicativo. Para dados que não pode editar (por
   exemplo, eventos de auditoria, que são imutáveis por design),
   envie e-mail solicitando uma nota de correção anexada ao
   registro.
3. **Exclusão**. Você pode excluir seu tenant em Configurações →
   Excluir tenant. A exclusão é irreversível após período de 7
   dias de graça; dados do tenant são removidos do banco; entradas
   do log de auditoria sobre a própria exclusão são retidas para
   registro legal.
4. **Portabilidade**. A exportação do tenant acima é um arquivo
   JSON estruturado com todos os dados do tenant; esse é o formato
   portável.
5. **Informação sobre com quem compartilhamos**. Veja as categorias
   de sub-processadores acima. Podemos divulgar o fornecedor
   específico sob NDA mediante necessidade contratual ou regulatória.
6. **Revogação de consentimento**. Onde o tratamento se baseia em
   consentimento (raro; a maioria do tratamento é necessária ao
   contrato), você pode revogar no aplicativo ou por e-mail.
7. **Objeção** ao tratamento baseado em legítimo interesse apenas.
   Note que objetar à telemetria de segurança normalmente significa
   que a conta não pode continuar operando.
8. **Informação sobre a base legal** de qualquer tratamento — veja
   "Por que coletamos" acima; pergunte se algo estiver pouco claro.

Para pedidos de titular onde não podemos verificar sua identidade
pela conta (por exemplo, conta encerrada), pediremos verificação
adicional antes de responder.

## Crianças

A Panorama foi construída para operações de frota — não é direcionada
a crianças menores de 18 anos. Não coletamos dados conscientemente
sobre menores de 18. Se um operador de tenant criar contas para
usuários menores de 18 (por exemplo, em contexto de organização
juvenil), o operador é o controlador desses dados e responsável
pelo consentimento parental conforme a lei local aplicável.

## Cookies e tecnologias similares

Usamos dois cookies estritamente necessários na instância hospedada:

- Um **cookie de sessão** (\`panorama_session\`) — criptografado com
  chave rotativa, dura 7 dias, atualiza no uso. Necessário para
  manter você conectado.
- Um **cookie de idioma** (\`panorama_locale\`) — guarda sua
  preferência de idioma da interface. Definido quando você muda
  de idioma.

Não usamos cookies de analytics, marketing ou tracking.

## Transferências internacionais

A instância hospedada da Panorama roda na região que você
selecionar no cadastro. Não transferimos seus dados para região
diferente sem seu consentimento. O mantenedor está sediado no
Brasil; dados transferidos a provedores fora do Brasil estão
sujeitos à LGPD Art. 33 (decisões de adequação ou cláusulas
contratuais padrão); a divulgação específica de fornecedor inclui
a residência de dados de cada categoria.

## Alterações nesta política

Quando esta política mudar, notificaremos o e-mail da sua conta
com pelo menos 30 dias de antecedência. A data da versão atual
aparece no topo da página. Versões anteriores são rastreadas no
histórico git público do repositório Panorama em
github.com/VitorMRodovalho/panorama.

## Contato

Para qualquer dúvida, reclamação ou pedido de titular relacionado
a privacidade: vitor@vitormr.dev.

A função de DPO (Encarregado de Proteção de Dados) sob a LGPD é
atualmente exercida pelo mesmo mantenedor. Quando a instância
hospedada tiver tenants pagantes e um DPO separado for nomeado,
esta seção o nomeará. O e-mail vitor@vitormr.dev é monitorado de
qualquer forma.

Você também pode contactar a Autoridade Nacional de Proteção de
Dados (ANPD) em gov.br/anpd se considerar que não tratamos seu
pedido adequadamente.

---

**Aviso de status (este rascunho).** Esta é a versão v1 em
linguagem clara do plano Round 7 da aceitação Wave 0. O mantenedor
contratará assessoria jurídica qualificada antes de a URL hospedada
da Panorama ser anunciada publicamente a uma audiência pagante. O
texto pode mudar após revisão jurídica; o aviso de alteração de 30
dias acima se aplica a qualquer revisão pós-revisão jurídica.
`,

  es: `
**Versión en español pendiente.** El texto canónico de la Política
de Privacidade de Panorama está disponible en inglés y portugués
brasileño en esta misma página, por favor seleccione su idioma en
el selector de idiomas o use el contenido en inglés / portugués
como referencia.

La traducción al español será publicada después de la revisión
jurídica de Round 7 (Wave 0 — antes del lanzamiento público de la
URL hospedada). Hasta entonces, la versión en inglés (canónica) o
portugués (mercado brasileño / LGPD) son los textos vigentes.

Para cualquier pregunta sobre privacidad, contacte:
vitor@vitormr.dev.
`,
} as const;
