/* eslint-disable no-param-reassign */

/**
 * A mongoose schema plugin which applies the following in the toJSON transform call:
 *  - removes __v, createdAt, updatedAt, and any path that has private: true
 *  - replaces _id with id
 */
import { Schema, Document } from 'mongoose';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deleteAtPath = (obj: any, path: string[], index: number): void => {
  if (index === path.length - 1) {
    delete obj[path[index]];
    return;
  }
  deleteAtPath(obj[path[index]], path, index + 1);
};

const toJSON = <T extends Document>(schema: Schema<T>): void => {
  schema.set('toJSON', {
    transform: function (doc, ret) {
      Object.keys(schema.paths).forEach((path) => {
        if (schema.paths[path].options && schema.paths[path].options.private) {
          deleteAtPath(ret, path.split('.'), 0);
        }
      });

      if (ret._id) {
        ret.id = ret._id.toString();
      }
      delete (ret as any)._id;
      delete (ret as any).__v;
    },
  });
};

export default toJSON;

// Previous implementation (not working)
// const toJSON = <T extends SchemaDocument>(schema: Schema<T>) => {
//   let transform: Function | undefined;

//   if (schema.options.toJSON && schema.options.toJSON.transform) {
//     transform = schema.options.toJSON.transform;
//   }

//   schema.options.toJSON = Object.assign(schema.options.toJSON || {}, {
//     transform(doc: T, ret: any, options: any) {
//       Object.keys(schema.paths).forEach((path) => {
//         if (schema.paths[path].options && schema.paths[path].options.private) {
//           deleteAtPath(ret, path.split('.'), 0);
//         }
//       });

//       if (ret._id) {
//         ret.id = ret._id.toString();
//       }
//       delete (ret as any)._id;
//       delete (ret as any).__v;

//       if (transform) {
//         return transform(doc, ret, options);
//       }
//     },
//   });
// };
