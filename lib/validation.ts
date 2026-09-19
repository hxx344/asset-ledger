import { z } from 'zod';
export const editSchema=z.object({id:z.string().regex(/^row-\d+$/),quantity:z.number().finite().min(0).max(1e15),price:z.number().finite().min(0).max(1e9).nullable()}).strict();
export const fxSchema=z.object({fx:z.number().finite().gt(0).max(1000)}).strict();
export const connectionSchema=z.discriminatedUnion('exchange',[
  z.object({exchange:z.literal('bybit'),apiKey:z.string().min(5).max(256),apiSecret:z.string().min(5).max(256),region:z.enum(['global','nl','tr','kz','ge','ae','eu']).default('global')}).strict(),
  z.object({exchange:z.literal('aster'),apiKey:z.string().min(5).max(256),apiSecret:z.string().min(5).max(256),includeSpot:z.boolean().default(false)}).strict(),
]);
export function editValue(quantity:number,price:number|null){
  if(quantity===0) return 0;
  if(price===null) throw new Error('数量大于零时，请填写单价');
  return quantity*price;
}
