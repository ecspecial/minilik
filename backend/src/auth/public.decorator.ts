import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Маркировка HTTP-маршрута: без JWT (например, `<img src="…">` без заголовка Authorization). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
