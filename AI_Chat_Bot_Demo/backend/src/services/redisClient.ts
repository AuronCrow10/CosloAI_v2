import Redis from "ioredis";
import { config } from "../config";

let redisInstance: Redis | null = null;

export function getRedis(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(config.redisUrl);
    redisInstance.on("error", (err) => {
      console.error("Redis connection error", err);
    });
  }
  return redisInstance;
}
