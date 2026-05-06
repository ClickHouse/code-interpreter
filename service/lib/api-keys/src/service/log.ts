import mongoose from 'mongoose';
import Log, { type ILog } from '../models/Log';

export interface CreateLogInput {
  input: string;
  run: {
    signal: string | number | null;
    stdout?: string;
    stderr?: string;
    code: number;
    output: string;
    memory: number | null;
    message: string;
    status: string;
    cpu_time: number;
    wall_time: number;
  };
  language: string;
  version: string;
  session_id: string;
  files: Array<{
    id: string;
    name: string;
  }>;
  userId: string;
}

export const createLog = async (
  data: CreateLogInput
): Promise<mongoose.Document<unknown, object, ILog>> => {
  try {
    const log = await Log.create(data);
    return log;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to create log: ${error.message}`);
    }
    throw error;
  }
};

export const getLogsByUserId = async (
  userId: string
): Promise<mongoose.FlattenMaps<ILog & { _id: mongoose.Types.ObjectId }>[]> => {
  try {
    return await Log.find({ userId }).lean();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch logs: ${error.message}`);
    }
    throw error;
  }
};

export const getLogsBySessionId = async (
  sessionId: string
): Promise<mongoose.FlattenMaps<ILog & { _id: mongoose.Types.ObjectId }>[]> => {
  try {
    return await Log.find({ session_id: sessionId }).lean();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch logs: ${error.message}`);
    }
    throw error;
  }
};

export const getLogById = async (
  logId: string
): Promise<mongoose.FlattenMaps<
  ILog & { _id: mongoose.Types.ObjectId }
> | null> => {
  try {
    return await Log.findById(logId).lean();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch log: ${error.message}`);
    }
    throw error;
  }
};
