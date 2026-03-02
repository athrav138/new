import { GoogleGenAI, GenerateContentParameters, GenerateContentResponse } from "@google/genai";

/**
 * Calls Gemini API with exponential backoff retry logic for 503 and 429 errors.
 */
export async function generateContentWithRetry(
  ai: GoogleGenAI,
  params: GenerateContentParameters,
  maxRetries = 3
): Promise<GenerateContentResponse> {
  let lastError: any;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: any) {
      lastError = err;
      const errorMessage = err?.message || "";
      const isRetryable = 
        errorMessage.includes('503') || 
        errorMessage.includes('UNAVAILABLE') || 
        errorMessage.includes('429') || 
        errorMessage.includes('RESOURCE_EXHAUSTED') ||
        errorMessage.includes('high demand');

      if (isRetryable && i < maxRetries - 1) {
        // Exponential backoff: 2s, 4s, 8s... with some jitter
        const delay = Math.pow(2, i + 1) * 1000 + Math.random() * 1000;
        console.warn(`Gemini API busy (Attempt ${i + 1}/${maxRetries}). Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Calls Gemini API Stream with exponential backoff retry logic for 503 and 429 errors.
 * Note: Retrying a stream means restarting the entire stream.
 */
export async function generateContentStreamWithRetry(
  ai: GoogleGenAI,
  params: GenerateContentParameters,
  maxRetries = 3
) {
  let lastError: any;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await ai.models.generateContentStream(params);
    } catch (err: any) {
      lastError = err;
      const errorMessage = err?.message || "";
      const isRetryable = 
        errorMessage.includes('503') || 
        errorMessage.includes('UNAVAILABLE') || 
        errorMessage.includes('429') || 
        errorMessage.includes('RESOURCE_EXHAUSTED') ||
        errorMessage.includes('high demand');

      if (isRetryable && i < maxRetries - 1) {
        const delay = Math.pow(2, i + 1) * 1000 + Math.random() * 1000;
        console.warn(`Gemini API Stream busy (Attempt ${i + 1}/${maxRetries}). Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
