/**
 * Фиксированные учётки для e2e (перекрывают .env), чтобы тесты не зависели от машины.
 */
process.env.AUTH_LOGIN_USER_1 = 'e2e_user_a';
process.env.AUTH_LOGIN_PASS_1 = 'e2e_pass_a';
process.env.AUTH_LOGIN_USER_2 = 'e2e_user_b';
process.env.AUTH_LOGIN_PASS_2 = 'e2e_pass_b';
process.env.JWT_SECRET = 'e2e-jwt-secret-at-least-32-chars-long';
process.env.OPENAI_API_KEY = 'sk-e2e-placeholder';
