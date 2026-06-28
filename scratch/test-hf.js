const OpenAI = require('openai');

const hf = new OpenAI({
  apiKey: 'hf_dummy_token', // Using a dummy token to see if it gives 401 or Connection error
  baseURL: 'https://api-inference.huggingface.co/v1'
});

async function test() {
  try {
    const completion = await hf.chat.completions.create({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'meta-llama/Meta-Llama-3-8B-Instruct',
    });
    console.log(completion.choices[0].message);
  } catch (err) {
    console.error('Error:', err.message);
  }
}
test();
