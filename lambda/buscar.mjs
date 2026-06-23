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
      SecretId: 'arn:aws:secretsmanager:us-east-1:058264267889:secret:cadastro-clientes/rds/credentials-1ufG5x',
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
    const { id } = event.pathParameters;

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