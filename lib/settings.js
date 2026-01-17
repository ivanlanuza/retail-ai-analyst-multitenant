import { ChatOpenAI } from "@langchain/openai";

export const MODEL_NAME = "gpt-4o-mini";

export const llm = new ChatOpenAI({ model: MODEL_NAME, temperature: 0 });

export const MAX_TABLE_ROWS_IN_RESPONSE = 20; // must match prompt rule unless user asks otherwise

export const CSV_EXPORT_ROW_THRESHOLD = 21; // when >= this, include csv export payload
