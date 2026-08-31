-- Estrutura mínima para registrar conversas e consumo de token.
--
-- ⚖️ NADA NO CÓDIGO DEPENDE DISTO. O gateway roda sem banco: o `NullConversationRepository` é o que
-- está plugado, e ele descarta. Este arquivo existe para o dia em que alguém quiser guardar — a
-- implementação nova precisa satisfazer `IConversationRepository`, e é só trocar uma linha na
-- `Usecases.Factory`.
--
-- MySQL 8+ (precisa de JSON e de `ON UPDATE CURRENT_TIMESTAMP`).
--   mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS agents_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE agents_gateway;

-- Cabeçalho da conversa. O acumulado vive aqui para a listagem não precisar somar turnos.
CREATE TABLE IF NOT EXISTS conversations (
  id            VARCHAR(64)  NOT NULL PRIMARY KEY,
  agent_id      VARCHAR(128) NOT NULL,
  provider      VARCHAR(32)  NOT NULL,
  mode          VARCHAR(16)  NOT NULL,
  model         VARCHAR(128) NOT NULL,
  -- Primeira linha da pergunta que abriu a conversa. Existe para a listagem ter rótulo sem
  -- precisar abrir o primeiro turno de cada linha.
  title         VARCHAR(64)  NULL,
  turns         INT UNSIGNED NOT NULL DEFAULT 0,

  -- ⚠️ OS TRÊS SEPARADOS, e NOT NULL com default 0.
  --
  -- Separados porque o raciocínio é cobrado como saída, e somá-lo ali daria o total certo apagando
  -- a informação que interessa: quanto do gasto foi o modelo pensando. É essa parcela que muda ao
  -- trocar de modelo ou de nível de esforço.
  --
  -- NOT NULL porque `NULL` em contador contamina toda soma feita em cima dele depois — e o sintoma
  -- é um relatório com o número faltando, não um erro.
  input_tokens      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reasoning_tokens  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_tokens      BIGINT UNSIGNED NOT NULL DEFAULT 0,

  -- Quem é o dono da conversa, no formato de quem chamou. O gateway não interpreta o conteúdo.
  metadata      JSON NULL,

  created_at    DATETIME(3) NOT NULL,
  updated_at    DATETIME(3) NOT NULL,

  -- Listagem é sempre "as mais recentes primeiro".
  KEY idx_conversations_updated (updated_at DESC),
  -- Comparar custo por modelo é a pergunta que o `byModel` do `IConversationStats` responde.
  KEY idx_conversations_model (provider, model)
) ENGINE=InnoDB;

-- Um turno: o que foi perguntado, o que foi respondido, e o que o agente fez no caminho.
CREATE TABLE IF NOT EXISTS conversation_turns (
  conversation_id  VARCHAR(64)  NOT NULL,
  -- ⚠️ O índice vem do contador do PROVIDER, não de um COUNT aqui. Contar no banco custaria uma
  -- leitura por turno e devolveria zero enquanto o banco não existisse — todo turno sobrescrevendo
  -- o primeiro.
  idx              INT UNSIGNED NOT NULL,
  at               DATETIME(3)  NOT NULL,

  request          MEDIUMTEXT   NOT NULL,
  response         MEDIUMTEXT   NOT NULL,
  reasoning        MEDIUMTEXT   NULL,
  -- `[{ tool, args, result, error }]`. JSON porque o formato é de cada tool, e normalizar isto em
  -- colunas seria inventar um esquema para dado que o gateway só transporta.
  tool_calls       JSON         NULL,
  warnings         JSON         NULL,

  input_tokens     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_tokens     BIGINT UNSIGNED NOT NULL DEFAULT 0,

  -- Turno interrompido é registro, não erro: é o que alguém vai querer investigar depois.
  aborted          TINYINT(1)   NOT NULL DEFAULT 0,
  error            TEXT         NULL,

  PRIMARY KEY (conversation_id, idx),
  -- Apagar a conversa apaga os turnos. Isso NÃO encosta na sessão viva do provider — são coisas
  -- distintas, e o histórico sumir não significa que a conversa parou.
  CONSTRAINT fk_turns_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
) ENGINE=InnoDB;
