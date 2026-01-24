// The Hitchhiker's Guide to Grok
// Welcome! In this guide, we'll walk you through the basics of using the xAI API.

// Step 1: Create an xAI Account
// First, you'll need to create an xAI account to access xAI API. Sign up for an account here.

// Once you've created an account, you'll need to load it with credits to start using the API.

// Step 2: Generate an API Key
// Create an API key via the API Keys Page in the xAI API Console.

// After generating an API key, we need to save it somewhere safe! We recommend you export it as an environment variable in your terminal or save it to a 
// .env
//  file.

// Bash


// export XAI_API_KEY="your_api_key"
// Step 3: Make your first request
// With your xAI API key exported as an environment variable, you're ready to make your first API request.

// Let's test out the API using 
// curl
// . Paste the following directly into your terminal.

// Bash


// curl https://api.x.ai/v1/responses \
// -H "Content-Type: application/json" \
// -H "Authorization: Bearer $XAI_API_KEY" \
// -m 3600 \
// -d '{
//     "input": [
//         {
//             "role": "system",
//             "content": "You are Grok, a highly intelligent, helpful AI assistant."
//         },
//         {
//             "role": "user",
//             "content": "What is the meaning of life, the universe, and everything?"
//         }
//     ],
//     "model": "grok-4"
// }'
// Step 4: Make a request from Python or Javascript
// As well as a native xAI Python SDK, the majority of our APIs are fully compatible with the OpenAI SDK (and the Anthropic SDK, although this is now deprecated). For example, we can make the same request from Python or JavaScript like so:

// Anthropic SDK Deprecated: The Anthropic SDK compatibility is fully deprecated. Please migrate to the Responses API or gRPC.


// Python

// Javascript
// Bash

// curl https://api.x.ai/v1/chat/completions \
// -H "Content-Type: application/json" \
// -H "Authorization: Bearer $XAI_API_KEY" \
// -m 3600 \
// -d '{
//     "input": [
//         {
//             "role": "system",
//             "content": "You are Grok, a highly intelligent, helpful AI assistant."
//         },
//         {
//             "role": "user",
//             "content": "What is the meaning of life, the universe, and everything?"
//         }
//     ],
//     "model": "grok-4"
// }'
// Certain models also support Structured Outputs, which allows you to enforce a schema for the LLM output.

// For an in-depth guide about using Grok for text responses, check out our Chat Guide.