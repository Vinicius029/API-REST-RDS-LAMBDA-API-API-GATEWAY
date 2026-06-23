# Cadastro de Clientes — AWS Serverless

API REST serverless para cadastro de clientes construída inteiramente na AWS, utilizando Amazon API Gateway, AWS Lambda, Amazon RDS PostgreSQL, AWS IAM e AWS Secrets Manager.

---

## Índice

1. [Visão Geral da Arquitetura](#visão-geral-da-arquitetura)
2. [Infraestrutura de Rede](#infraestrutura-de-rede)
3. [Recursos Criados](#recursos-criados)
4. [Etapa 1 — IAM](#etapa-1--iam)
5. [Etapa 2 — Security Groups](#etapa-2--security-groups)
6. [Etapa 3 — Amazon RDS](#etapa-3--amazon-rds)
7. [Etapa 4 — AWS Lambda](#etapa-4--aws-lambda)
8. [Etapa 5 — API Gateway](#etapa-5--api-gateway)
9. [Gerenciamento de Custos](#gerenciamento-de-custos)
10. [Exemplos de Requisições](#exemplos-de-requisições)
11. [Referências da Conta](#referências-da-conta)

---

## Visão Geral da Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│                        INTERNET                                 │
│                                                                 │
│   Cliente (Insomnia / curl / Browser)                           │
│          │                                                      │
│          │ HTTPS                                                │
└──────────┼──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────┐
│     API Gateway         │  ← porta de entrada da aplicação
│   REST API — dev stage  │    recebe, roteia e repassa
│                         │    as requisições HTTP
└──────────┬──────────────┘
           │ Lambda Proxy Integration
           │ (passa evento completo para o Lambda)
           ▼
┌─────────────────────────┐      ┌──────────────────────────────┐
│      AWS Lambda         │ ───► │      Secrets Manager         │
│      Node.js 20.x       │      │  cadastro-clientes/rds/      │
│                         │      │  credentials                 │
│  5 funções:             │      │                              │
│  - criar                │      │  Armazena: host, porta,      │
│  - listar               │      │  usuário e senha do RDS      │
│  - buscar               │      └──────────────────────────────┘
│  - atualizar            │
│  - deletar              │
└──────────┬──────────────┘
           │ SQL — porta 5432
           │ (subnet privada — sem acesso público)
           ▼
┌─────────────────────────┐
│      Amazon RDS         │
│   PostgreSQL 16.x       │
│   db.t3.micro           │
│   subnet privada        │
│   tabela: clientes      │
└─────────────────────────┘

Serviços de suporte (sem fluxo de dados direto):
┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
│   AWS IAM    │  │  VPC Endpoints   │  │  CloudWatch  │
│  Roles +     │  │  Interface para  │  │  Logs das    │
│  Policies    │  │  Secrets Manager │  │  funções     │
└──────────────┘  └──────────────────┘  └──────────────┘
```

### Por que essa arquitetura?

| Componente | Motivo |
|---|---|
| **API Gateway** | Desacopla o cliente da lógica. Gerencia throttling, autenticação e roteamento sem código |
| **Lambda** | Sem servidor para gerenciar. Escala automaticamente. Paga apenas por execução |
| **RDS em subnet privada** | Banco nunca exposto à internet. Acesso apenas por recursos da VPC |
| **Secrets Manager** | Credenciais nunca no código. Suporte a rotação automática de senha |
| **VPC Endpoint** | Comunicação com Secrets Manager sem sair da rede AWS. Sem NAT Gateway |

---

## Infraestrutura de Rede

> Reutilizada de projeto anterior. Não foi criada neste projeto.

| Recurso | Nome | ID |
|---|---|---|
| VPC | `vpc-lab` | `vpc-04295` |
| Subnet privada 1 | `sub-pvt-1a` | `subnet-061266b` |
| Subnet privada 2 | `sub-pvt-1b` | `subnet-0cf447` |
| AZ subnet 1 | `us-east-1a` | — |
| AZ subnet 2 | `us-east-1b` | — |
| CIDR da VPC | `10.0.0.0/16` | — |
| Região | `us-east-1` | — |

---

## Recursos Criados

| Serviço | Nome | Finalidade |
|---|---|---|
| IAM Policy | `cadastro-clientes-lambda-policy` | Permissões mínimas para o Lambda |
| IAM Role | `cadastro-clientes-lambda-role` | Identidade assumida pelo Lambda |
| Security Group | `cadastro-clientes-lambda-sg` | Firewall das funções Lambda |
| Security Group | `cadastro-clientes-rds-sg` | Firewall do RDS |
| Security Group | `cadastro-clientes-bastion-sg` | Firewall do bastion (temporário) |
| Security Group | `cadastro-clientes-endpoints-sg` | Firewall dos VPC Endpoints |
| RDS Subnet Group | `cadastro-clientes-subnet-group` | Define subnets disponíveis para o RDS |
| RDS PostgreSQL | `cadastro-clientes-db` | Banco de dados principal |
| Secret | `cadastro-clientes/rds/credentials` | Credenciais do banco |
| Lambda | `cadastro-clientes-criar` | Lógica do POST /clientes |
| Lambda | `cadastro-clientes-listar` | Lógica do GET /clientes |
| Lambda | `cadastro-clientes-buscar` | Lógica do GET /clientes/{id} |
| Lambda | `cadastro-clientes-atualizar` | Lógica do PUT /clientes/{id} |
| Lambda | `cadastro-clientes-deletar` | Lógica do DELETE /clientes/{id} |
| API Gateway | `cadastro-clientes-api` | REST API pública |

### Tags aplicadas em todos os recursos

| Key | Value |
|---|---|
| `Project` | `cadastro-clientes` |
| `Environment` | `dev` |
| `ManagedBy` | `console` |

---

## Etapa 1 — IAM

O IAM (Identity and Access Management) controla quem pode fazer o quê na AWS.
Criamos primeiro porque nenhum recurso funciona sem permissão.

### Conceitos utilizados

- **Policy** — documento JSON que define as permissões (o que pode fazer e em qual recurso)
- **Role** — identidade assumida por serviços AWS. O Lambda não tem login/senha — ele assume uma Role
- **Least Privilege** — conceder apenas as permissões mínimas necessárias
- **Trust Policy** — define quem pode assumir a Role (no caso, o serviço Lambda)

### 1.1 Criar a IAM Policy

**Console → IAM → Policies → Create policy → aba JSON**

Cole o JSON abaixo e substitua os valores de `Resource` pelos ARNs reais da sua conta:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:ACCOUNT_ID:log-group:/aws/lambda/cadastro-clientes*"
    },
    {
      "Sid": "AllowSecretsManager",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:cadastro-clientes/rds/credentials-SUFIXO"
    }
  ]
}
```

> **Por que dois statements?**
> - `AllowCloudWatchLogs` — permite que o Lambda escreva logs automaticamente no CloudWatch
> - `AllowSecretsManager` — permite que o Lambda leia as credenciais do RDS em tempo de execução

**Configurações:**
- **Policy name:** `cadastro-clientes-lambda-policy`
- **Description:** `Permissões mínimas para a Lambda do projeto cadastro-clientes`
- Adicionar tags padrão do projeto

### 1.2 Criar a IAM Role

**Console → IAM → Roles → Create role**

**Tela 1 — Trusted entity:**
- **Trusted entity type:** `AWS service`
- **Use case:** `Lambda`

> Isso cria a Trust Policy que autoriza o serviço Lambda a assumir essa Role via STS.

**Tela 2 — Add permissions:**
- Buscar e selecionar: `cadastro-clientes-lambda-policy`
- Buscar e selecionar: `AWSLambdaVPCAccessExecutionRole`

> `AWSLambdaVPCAccessExecutionRole` é uma AWS Managed Policy obrigatória para Lambda dentro de VPC.
> Ela permite criar e gerenciar ENIs (Elastic Network Interfaces) na VPC.
> Sem ela, o Lambda não consegue se conectar à rede privada e retorna o erro:
> `does not have permissions to call CreateNetworkInterface on EC2`

**Tela 3 — Name:**
- **Role name:** `cadastro-clientes-lambda-role`
- **Description:** `Role assumida pela Lambda do projeto cadastro-clientes`
- Adicionar tags padrão do projeto

### 1.3 Verificar a Trust Policy

Após criar, acesse a Role e clique na aba **Trust relationships**.
O JSON deve ser exatamente este:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

---

## Etapa 2 — Security Groups

Security Groups funcionam como firewalls virtuais. Controlam o tráfego de entrada (Inbound) e saída (Outbound) dos recursos.

> **Boa prática:** usar o Security Group como source em vez de IPs fixos.
> Assim, qualquer recurso com aquele SG é automaticamente liberado — sem precisar gerenciar IPs.

### 2.1 SG do Lambda — `cadastro-clientes-lambda-sg`

**Console → VPC → Security groups → Create security group**

- **Name:** `cadastro-clientes-lambda-sg`
- **Description:** `Security Group da Lambda do projeto cadastro-clientes`
- **VPC:** `vpc-lab`
- **Inbound rules:** nenhuma regra
  - Lambda não recebe conexões — ele apenas inicia conexões de saída
- **Outbound rules:** `All traffic / 0.0.0.0/0` (padrão)
  - Permite que o Lambda conecte ao RDS e ao VPC Endpoint do Secrets Manager

### 2.2 SG do RDS — `cadastro-clientes-rds-sg`

- **Name:** `cadastro-clientes-rds-sg`
- **Description:** `Security Group do RDS do projeto cadastro-clientes`
- **VPC:** `vpc-lab`
- **Inbound rules:**

| Type | Protocol | Port | Source |
|---|---|---|---|
| PostgreSQL | TCP | 5432 | `cadastro-clientes-lambda-sg` |
| PostgreSQL | TCP | 5432 | `cadastro-clientes-bastion-sg` |

> A regra do bastion é temporária — usada apenas para criar a tabela.
> Em produção, remova essa regra após finalizar a configuração inicial.

- **Outbound rules:** `All traffic / 0.0.0.0/0` (padrão)

### 2.3 SG do Bastion — `cadastro-clientes-bastion-sg`

- **Name:** `cadastro-clientes-bastion-sg`
- **Description:** `Security Group do Bastion Host do projeto cadastro-clientes`
- **VPC:** `vpc-lab`
- **Inbound rules:** nenhuma regra
  - Acesso via SSM Session Manager — não precisa de porta aberta
- **Outbound rules:** `All traffic / 0.0.0.0/0` (padrão)

### 2.4 SG dos VPC Endpoints — `cadastro-clientes-endpoints-sg`

- **Name:** `cadastro-clientes-endpoints-sg`
- **Description:** `Security Group dos VPC Endpoints do projeto cadastro-clientes`
- **VPC:** `vpc-lab`
- **Inbound rules:**

| Type | Protocol | Port | Source |
|---|---|---|---|
| HTTPS | TCP | 443 | `10.0.0.0/16` |

> O CIDR `10.0.0.0/16` é o range de IPs da VPC.
> Permite que qualquer recurso da VPC se comunique com os endpoints via HTTPS.

- **Outbound rules:** `All traffic / 0.0.0.0/0` (padrão)

---

## Etapa 3 — Amazon RDS

O RDS (Relational Database Service) é o banco de dados gerenciado da AWS.
A instância fica em subnet privada — sem acesso público, acessível apenas por recursos da VPC.

### 3.1 Criar o RDS Subnet Group

O Subnet Group define em quais subnets o RDS pode ser criado.
A AWS exige no mínimo duas AZs diferentes, mesmo em Single-AZ.

**Console → RDS → Subnet groups → Create DB subnet group**

- **Name:** `cadastro-clientes-subnet-group`
- **Description:** `Subnet group do RDS do projeto cadastro-clientes`
- **VPC:** `vpc-lab`
- **Availability zones:** `us-east-1a` e `us-east-1b`
- **Subnets:** `sub-pvt-1a` e `sub-pvt-1b`
- Adicionar tags padrão do projeto

### 3.2 Criar a instância RDS

**Console → RDS → Databases → Create database**

| Seção | Campo | Valor |
|---|---|---|
| Creation method | — | Standard create |
| Engine | Engine type | PostgreSQL |
| Engine | Version | PostgreSQL 16.x (mais recente disponível) |
| Templates | — | Dev/Test |
| Settings | DB identifier | `cadastro-clientes-db` |
| Settings | Master username | `postgres` |
| Settings | Credentials management | Self managed |
| Settings | Master password | senha forte (anotar para o Secrets Manager) |
| Instance | DB instance class | Burstable → `db.t3.micro` |
| Storage | Storage type | `gp2` |
| Storage | Allocated storage | `20 GiB` |
| Storage | Storage autoscaling | **Desabilitado** |
| Connectivity | Compute resource | Don't connect to EC2 |
| Connectivity | Network type | IPv4 |
| Connectivity | VPC | `vpc-lab` |
| Connectivity | Subnet group | `cadastro-clientes-subnet-group` |
| Connectivity | Public access | **No** |
| Connectivity | Security group | `cadastro-clientes-rds-sg` |
| Connectivity | AZ | `us-east-1a` |
| Authentication | — | Password authentication |
| Monitoring | Enhanced Monitoring | **Desabilitado** |
| Monitoring | Performance Insights | **Desabilitado** |
| Additional | Initial database name | `cadastro_clientes` |
| Additional | Backup retention | `1 day` |
| Additional | Encryption | Habilitado |

> **Por que Public access: No?**
> O banco nunca deve ser acessível pela internet.
> Apenas recursos dentro da VPC (Lambda, bastion) podem conectar.

Após criação, anote o **Endpoint** e **Port**:
- **Endpoint:** `cadastro-clientes-db.cij2ke600ggf.us-east-1.rds.amazonaws.com`
- **Port:** `5432`

### 3.3 Armazenar credenciais no Secrets Manager

**Console → Secrets Manager → Store a new secret**

**Tela 1 — Secret type:**
- **Type:** `Credentials for Amazon RDS database`
- **Username:** `postgres`
- **Password:** senha criada no passo anterior
- **Database:** selecionar `cadastro-clientes-db`

**Tela 2 — Secret name:**
- **Name:** `cadastro-clientes/rds/credentials`
- **Description:** `Credenciais do RDS PostgreSQL do projeto cadastro-clientes`
- Adicionar tags padrão do projeto

**Tela 3 — Rotation:** deixar desabilitado

Após criar, anote o **ARN do Secret**:
```
arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:cadastro-clientes/rds/credentials-SUFIXO
```

> O sufixo (ex: `-1ufG5x`) é gerado automaticamente pela AWS para garantir unicidade.

### 3.4 Atualizar a IAM Policy com os ARNs reais

Agora que temos os ARNs reais, volte na policy e restrinja o `Resource`:

**Console → IAM → Policies → `cadastro-clientes-lambda-policy` → Edit → JSON**

Substitua `*` pelos ARNs específicos (conforme JSON da Etapa 1).

### 3.5 Criar a tabela no banco via Bastion Host

O banco está em subnet privada — não é possível conectar diretamente do computador local.
Usamos um EC2 temporário como bastion host, acessado via SSM Session Manager (sem SSH, sem porta 22).

#### Criar NAT Gateway (necessário para SSM em subnet privada)

**Console → VPC → NAT Gateways → Create NAT Gateway**

- **Name:** `cadastro-clientes-nat-gw`
- **Subnet:** subnet pública da VPC
- **Connectivity type:** Public
- Clicar em **Allocate Elastic IP**
- Adicionar tags padrão do projeto

Aguardar status **Available**.

#### Atualizar Route Table da subnet privada

**Console → VPC → Route tables → selecionar RT da subnet privada → Routes → Edit routes**

Adicionar rota:
| Destination | Target |
|---|---|
| `0.0.0.0/0` | NAT Gateway `cadastro-clientes-nat-gw` |

#### Criar EC2 bastion

**Console → EC2 → Launch instance**

| Campo | Valor |
|---|---|
| Name | `cadastro-clientes-bastion` |
| AMI | Amazon Linux 2023 |
| Instance type | `t2.micro` |
| Key pair | Proceed without a key pair |
| VPC | `vpc-lab` |
| Subnet | `sub-pvt-1a` |
| Auto-assign public IP | Disable |
| Security group | `cadastro-clientes-bastion-sg` |
| IAM instance profile | Role com `AmazonSSMManagedInstanceCore` |

Aguardar status **Running** e então aguardar mais **2 minutos** para o SSM Agent inicializar.

#### Conectar via SSM e criar a tabela

**Console → EC2 → selecionar instância → Connect → Session Manager → Connect**

No terminal que abrir:

```bash
# Instalar cliente PostgreSQL
sudo dnf install -y postgresql15

# Conectar ao banco
psql -h cadastro-clientes-db.cij2ke600ggf.us-east-1.rds.amazonaws.com \
     -U postgres \
     -d cadastro_clientes
```

Digitar a senha quando solicitado. No prompt do PostgreSQL:

```sql
-- Criar a tabela
CREATE TABLE clientes (
    id            SERIAL PRIMARY KEY,
    nome          VARCHAR(100) NOT NULL,
    email         VARCHAR(150) NOT NULL UNIQUE,
    telefone      VARCHAR(20),
    data_cadastro TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Verificar criação
\dt

-- Sair
\q
```

#### Limpar recursos temporários após criar a tabela

| Recurso | Ação | Motivo |
|---|---|---|
| EC2 bastion | Terminate | Não precisamos mais dele |
| NAT Gateway | Delete | Cobra ~U$0,045/hora mesmo parado |
| Elastic IP | Release | Cobra ~U$0,005/hora quando não associado |

---

## Etapa 4 — AWS Lambda

O Lambda executa código sem servidor. Paga-se apenas pelo tempo de execução.
Cada função tem responsabilidade única — uma operação CRUD por função.

### Conceitos importantes

**Cold Start vs Warm Start:**
- **Cold Start** — primeira invocação: AWS baixa o código, inicializa o runtime e executa o handler (~100ms a 1s+)
- **Warm Start** — invocações seguintes: execution environment reutilizado, vai direto ao handler (~ms)
- **Boa prática:** inicializar a conexão com o banco **fora** do handler para reutilizar no warm start

**Lambda dentro de VPC:**
- Necessário para acessar o RDS em subnet privada
- Perde acesso à internet e a serviços AWS públicos
- Solução: VPC Endpoint para o Secrets Manager

### 4.1 Preparar o código localmente

```bash
# Criar estrutura do projeto
mkdir -p ~/cadastro-clientes/lambda
cd ~/cadastro-clientes/lambda

# Inicializar projeto Node.js
npm init -y
npm pkg set type="module"

# Instalar dependências
# pg: driver PostgreSQL para Node.js
# @aws-sdk/client-secrets-manager: SDK para buscar as credenciais
npm install pg @aws-sdk/client-secrets-manager
```

### 4.2 Código das funções

Criar os arquivos: `criar.mjs`, `listar.mjs`, `buscar.mjs`, `atualizar.mjs`, `deletar.mjs`

> **Estrutura padrão de todas as funções:**
> - Fora do handler: inicialização do cliente Secrets Manager e conexão com banco (reutilizada no warm start)
> - Dentro do handler: validação, lógica de negócio, query SQL e resposta

#### criar.mjs

```javascript
import pkg from 'pg';
const { Client } = pkg;

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// FORA do handler — executado uma vez no cold start
const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });
let dbClient = null;

async function getDbClient() {
  if (dbClient) return dbClient; // reutiliza conexão existente no warm start

  const secret = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: 'arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:cadastro-clientes/rds/credentials-SUFIXO',
    })
  );

  const credentials = JSON.parse(secret.SecretString);

  dbClient = new Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
    ssl: { rejectUnauthorized: false },
  });

  await dbClient.connect();
  return dbClient;
}

// DENTRO do handler — executado a cada requisição
export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { nome, email, telefone } = body;

    if (!nome || !email) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erro: 'nome e email são obrigatórios' }),
      };
    }

    const client = await getDbClient();

    const result = await client.query(
      `INSERT INTO clientes (nome, email, telefone)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [nome, email, telefone]
    );

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.rows[0]),
    };
  } catch (error) {
    console.error('Erro ao criar cliente:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: 'Erro interno do servidor' }),
    };
  }
};
```

#### listar.mjs

```javascript
import pkg from 'pg';
const { Client } = pkg;

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });
let dbClient = null;

async function getDbClient() {
  if (dbClient) return dbClient;

  const secret = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: 'arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:cadastro-clientes/rds/credentials-SUFIXO',
    })
  );

  const credentials = JSON.parse(secret.SecretString);

  dbClient = new Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
    ssl: { rejectUnauthorized: false },
  });

  await dbClient.connect();
  return dbClient;
}

export const handler = async (event) => {
  try {
    const client = await getDbClient();

    const result = await client.query(
      `SELECT * FROM clientes ORDER BY data_cadastro DESC`
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.rows),
    };
  } catch (error) {
    console.error('Erro ao listar clientes:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: 'Erro interno do servidor' }),
    };
  }
};
```

#### buscar.mjs

```javascript
import pkg from 'pg';
const { Client } = pkg;

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });
let dbClient = null;

async function getDbClient() {
  if (dbClient) return dbClient;

  const secret = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: 'arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:cadastro-clientes/rds/credentials-SUFIXO',
    })
  );

  const credentials = JSON.parse(secret.SecretString);

  dbClient = new Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
    ssl: { rejectUnauthorized: false },
  });

  await dbClient.connect();
  return dbClient;
}

export const handler = async (event) => {
  try {
    const id = event.pathParameters?.id;

    if (!id || isNaN(id)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erro: 'ID inválido' }),
      };
    }

    const client = await getDbClient();

    const result = await client.query(
      `SELECT * FROM clientes WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erro: 'Cliente não encontrado' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.rows[0]),
    };
  } catch (error) {
    console.error('Erro ao buscar cliente:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: 'Erro interno do servidor' }),
    };
  }
};
```

#### atualizar.mjs

```javascript
import pkg from 'pg';
const { Client } = pkg;

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });
let dbClient = null;

async function getDbClient() {
  if (dbClient) return dbClient;

  const secret = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: 'arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:cadastro-clientes/rds/credentials-SUFIXO',
    })
  );

  const credentials = JSON.parse(secret.SecretString);

  dbClient = new Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
    ssl: { rejectUnauthorized: false },
  });

  await dbClient.connect();
  return dbClient;
}

export const handler = async (event) => {
  try {
    const id = event.pathParameters?.id;

    if (!id || isNaN(id)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erro: 'ID inválido' }),
      };
    }

    const body = JSON.parse(event.body);
    const { nome, email, telefone } = body;

    if (!nome || !email) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erro: 'nome e email são obrigatórios' }),
      };
    }

    const client = await getDbClient();

    const result = await client.query(
      `UPDATE clientes
       SET nome = $1, email = $2, telefone = $3
       WHERE id = $4
       RETURNING *`,
      [nome, email, telefone, id]
    );

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erro: 'Cliente não encontrado' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.rows[0]),
    };
  } catch (error) {
    console.error('Erro ao atualizar cliente:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: 'Erro interno do servidor' }),
    };
  }
};
```

#### deletar.mjs

```javascript
import pkg from 'pg';
const { Client } = pkg;

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });
let dbClient = null;

async function getDbClient() {
  if (dbClient) return dbClient;

  const secret = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: 'arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:cadastro-clientes/rds/credentials-SUFIXO',
    })
  );

  const credentials = JSON.parse(secret.SecretString);

  dbClient = new Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
    ssl: { rejectUnauthorized: false },
  });

  await dbClient.connect();
  return dbClient;
}

export const handler = async (event) => {
  try {
    const id = event.pathParameters?.id;

    if (!id || isNaN(id)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erro: 'ID inválido' }),
      };
    }

    const client = await getDbClient();

    const result = await client.query(
      `DELETE FROM clientes
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erro: 'Cliente não encontrado' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mensagem: 'Cliente deletado com sucesso',
        cliente: result.rows[0],
      }),
    };
  } catch (error) {
    console.error('Erro ao deletar cliente:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: 'Erro interno do servidor' }),
    };
  }
};
```

### 4.3 Empacotar as funções

```bash
zip -r criar.zip    criar.mjs    node_modules package.json
zip -r listar.zip   listar.mjs   node_modules package.json
zip -r buscar.zip   buscar.mjs   node_modules package.json
zip -r atualizar.zip atualizar.mjs node_modules package.json
zip -r deletar.zip  deletar.mjs  node_modules package.json
```

> Cada zip terá aproximadamente 2.8MB (tamanho do node_modules com as dependências).
> O limite de upload direto no console é 50MB. Para pacotes maiores, usar S3.

### 4.4 Criar as funções no console

**Console → Lambda → Create function**

Repetir para cada uma das cinco funções:

| Campo | Valor |
|---|---|
| Author from scratch | — |
| Function name | `cadastro-clientes-{criar/listar/buscar/atualizar/deletar}` |
| Runtime | `Node.js 20.x` |
| Architecture | `x86_64` |
| Execution role | Use an existing role → `cadastro-clientes-lambda-role` |

Após criar cada função:

**1. Upload do zip:**
Code source → Upload from → .zip file → selecionar o zip correspondente

**2. Configurar o handler:**
Runtime settings → Edit → Handler: `{nome_arquivo}.handler`

Exemplos:
- `criar.mjs` → handler: `criar.handler`
- `listar.mjs` → handler: `listar.handler`

**3. Configurar timeout e memória:**
Configuration → General configuration → Edit
- **Memory:** `256 MB`
- **Timeout:** `30 seconds`

**4. Configurar VPC:**
Configuration → VPC → Edit
- **VPC:** `vpc-lab`
- **Subnets:** `sub-pvt-1a` e `sub-pvt-1b`
- **Security group:** `cadastro-clientes-lambda-sg`

**5. Adicionar tags:**
Configuration → Tags → Manage tags → adicionar tags padrão do projeto

### 4.5 Criar VPC Endpoint para Secrets Manager

Com o Lambda dentro da VPC, ele perde acesso a serviços AWS públicos como o Secrets Manager.
A solução é um VPC Endpoint Interface — o tráfego fica dentro da rede AWS.

**Console → VPC → Endpoints → Create endpoint**

| Campo | Valor |
|---|---|
| Name | `cadastro-clientes-secretsmanager-endpoint` |
| Service category | AWS services |
| Service | `com.amazonaws.us-east-1.secretsmanager` |
| VPC | `vpc-lab` |
| Subnets | `sub-pvt-1a` (us-east-1a) e `sub-pvt-1b` (us-east-1b) |
| Security group | `cadastro-clientes-endpoints-sg` |
| Policy | Full access |

Adicionar tags padrão do projeto. Aguardar status **Available**.

> **Importante:** Este endpoint deve ser recriado a cada sessão de estudos (gera custo contínuo).
> Deletar ao finalizar os estudos do dia.

---

## Etapa 5 — API Gateway

O API Gateway é a porta de entrada pública da aplicação.
Ele recebe requisições HTTPS, roteia para o Lambda correto e devolve a resposta.

### Conceitos utilizados

- **Resource** — caminho da URL (`/clientes`, `/clientes/{id}`)
- **Method** — verbo HTTP associado ao resource (GET, POST, PUT, DELETE)
- **Lambda Proxy Integration** — API Gateway passa o evento completo para o Lambda sem transformações
- **Stage** — versão publicada da API. Mudanças só ficam ativas após Deploy para um Stage
- **Path Parameter** — valor dinâmico na URL capturado como `{id}` e passado via `event.pathParameters`

### 5.1 Criar a API REST

**Console → API Gateway → Create API → REST API → Build**

| Campo | Valor |
|---|---|
| API name | `cadastro-clientes-api` |
| Description | `API REST do sistema de cadastro de clientes` |
| API endpoint type | `Regional` |

### 5.2 Criar o resource `/clientes`

Resources → Create resource

| Campo | Valor |
|---|---|
| Resource name | `clientes` |
| Resource path | `/clientes` |
| Enable API Gateway CORS | ✅ marcado |

### 5.3 Criar os métodos de `/clientes`

Com `/clientes` selecionado → Create method

**POST /clientes:**
| Campo | Valor |
|---|---|
| Method type | `POST` |
| Integration type | `Lambda function` |
| Lambda proxy integration | ✅ marcado |
| Lambda function | `cadastro-clientes-criar` |

**GET /clientes:**
| Campo | Valor |
|---|---|
| Method type | `GET` |
| Integration type | `Lambda function` |
| Lambda proxy integration | ✅ marcado |
| Lambda function | `cadastro-clientes-listar` |

### 5.4 Criar o resource `/clientes/{id}`

Com `/clientes` selecionado → Create resource

| Campo | Valor |
|---|---|
| Resource name | `{id}` |
| Resource path | `/clientes/{id}` |
| Enable API Gateway CORS | ✅ marcado |

### 5.5 Criar os métodos de `/clientes/{id}`

**GET /clientes/{id}:**
| Campo | Valor |
|---|---|
| Method type | `GET` |
| Lambda proxy integration | ✅ |
| Lambda function | `cadastro-clientes-buscar` |

**PUT /clientes/{id}:**
| Campo | Valor |
|---|---|
| Method type | `PUT` |
| Lambda proxy integration | ✅ |
| Lambda function | `cadastro-clientes-atualizar` |

**DELETE /clientes/{id}:**
| Campo | Valor |
|---|---|
| Method type | `DELETE` |
| Lambda proxy integration | ✅ |
| Lambda function | `cadastro-clientes-deletar` |

### 5.6 Configurar URL Path Parameters

> **Atenção:** sem esta configuração, o `event.pathParameters` chega como `null` no Lambda
> e os métodos GET, PUT e DELETE por ID não funcionam.

Para cada método do resource `/{id}` (GET, PUT, DELETE):

Method → Integration request → Edit → URL path parameters → Add path parameter

| Name | Mapped from |
|---|---|
| `id` | `method.request.path.id` |

Salvar e repetir para os três métodos.

### 5.7 Fazer o Deploy

Resources → botão **Deploy API** (canto superior direito)

| Campo | Valor |
|---|---|
| Stage | `*New stage*` |
| Stage name | `dev` |
| Description | `Ambiente de desenvolvimento` |

Após o deploy, a **Invoke URL** estará disponível em:
Stages → dev → Stage details → Invoke URL

**Invoke URL:** `https://yahdrras7e.execute-api.us-east-1.amazonaws.com/dev`

> Toda vez que alterar resources, métodos ou integrações, é necessário fazer um novo Deploy
> para as mudanças entrarem em vigor.

### 5.8 Estrutura final dos resources

```
/
└── /clientes
    ├── GET     → cadastro-clientes-listar
    ├── POST    → cadastro-clientes-criar
    ├── OPTIONS (CORS)
    └── /{id}
        ├── GET     → cadastro-clientes-buscar
        ├── PUT     → cadastro-clientes-atualizar
        ├── DELETE  → cadastro-clientes-deletar
        └── OPTIONS (CORS)
```

---

## Gerenciamento de Custos

### Ao iniciar sessão de estudos

| Ordem | Ação | Onde | Tempo de espera |
|---|---|---|---|
| 1 | Iniciar RDS | RDS → Databases → Actions → Start | ~5 minutos |
| 2 | Criar VPC Endpoint Secrets Manager | VPC → Endpoints → Create endpoint | ~2 minutos |

**Configurações do VPC Endpoint (para recriar rapidamente):**

| Campo | Valor |
|---|---|
| Name | `cadastro-clientes-secretsmanager-endpoint` |
| Service | `com.amazonaws.us-east-1.secretsmanager` |
| VPC | `vpc-lab` |
| Subnets | `sub-pvt-1a` e `sub-pvt-1b` |
| Security Group | `cadastro-clientes-endpoints-sg` |
| Policy | Full access |

### Ao finalizar sessão de estudos

| Ordem | Ação | Onde |
|---|---|---|
| 1 | Parar RDS | RDS → Databases → Actions → Stop temporarily |
| 2 | Deletar VPC Endpoint | VPC → Endpoints → selecionar → Actions → Delete |

### Tabela de custos dos recursos

| Recurso | Estado | Custo aproximado |
|---|---|---|
| RDS db.t3.micro | Rodando | ~U$0,018/hora |
| RDS db.t3.micro | Parado | ~U$0,046/mês (storage 20GB gp2) |
| VPC Endpoint Interface | Ativo | ~U$0,01/hora |
| NAT Gateway | Ativo | ~U$0,045/hora |
| Elastic IP | Não associado | ~U$0,005/hora |
| Lambda | — | U$0,0000002/invocação |
| API Gateway REST | — | U$3,50 por milhão de chamadas |
| Secrets Manager | — | ~U$0,40/mês por secret |
| Security Groups | — | Gratuito |
| IAM | — | Gratuito |
| VPC / Subnets | — | Gratuito |

---

## Exemplos de Requisições

**Base URL:** `https://yahdrras7e.execute-api.us-east-1.amazonaws.com/dev`

### POST /clientes — Criar cliente

```bash
curl -X POST https://yahdrras7e.execute-api.us-east-1.amazonaws.com/dev/clientes \
  -H "Content-Type: application/json" \
  -d '{"nome": "João Silva", "email": "joao@email.com", "telefone": "65999991234"}'
```

Body:
```json
{
  "nome": "João Silva",
  "email": "joao@email.com",
  "telefone": "65999991234"
}
```

Resposta (201):
```json
{
  "id": 1,
  "nome": "João Silva",
  "email": "joao@email.com",
  "telefone": "65999991234",
  "data_cadastro": "2026-06-21T16:26:01.139Z"
}
```

### GET /clientes — Listar todos

```bash
curl https://yahdrras7e.execute-api.us-east-1.amazonaws.com/dev/clientes
```

### GET /clientes/{id} — Buscar por ID

```bash
curl https://yahdrras7e.execute-api.us-east-1.amazonaws.com/dev/clientes/1
```

### PUT /clientes/{id} — Atualizar

```bash
curl -X PUT https://yahdrras7e.execute-api.us-east-1.amazonaws.com/dev/clientes/1 \
  -H "Content-Type: application/json" \
  -d '{"nome": "João Atualizado", "email": "joao.novo@email.com", "telefone": "65999990000"}'
```

Body:
```json
{
  "nome": "João Atualizado",
  "email": "joao.novo@email.com",
  "telefone": "65999990000"
}
```

### DELETE /clientes/{id} — Deletar

```bash
curl -X DELETE https://yahdrras7e.execute-api.us-east-1.amazonaws.com/dev/clientes/1
```

---
