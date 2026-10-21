import { METHODS as NODE_METHODS } from "http";

/** Every HTTP method Node parses, in lower case: the methods routes can be added for, like Express. */
export const METHODS: string[] = NODE_METHODS.map((method) => method.toLowerCase());

/** The methods the router itself refers to, in lower case. */
export enum HTTP_METHODS {
    GET = "get",
    POST = "post",
    PUT = "put",
    PATCH = "patch",
    DELETE = "delete",
    HEAD = "head",
    OPTIONS = "options"
}