import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;
type Parameter = ESTree.ParamPattern;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function parameterIdentifier(parameter: Parameter): ESTree.BindingIdentifier | null {
	if (parameter.type === "TSParameterProperty") {
		return parameterIdentifier(parameter.parameter);
	}
	if (parameter.type === "RestElement") {
		return parameterIdentifier(parameter.argument);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameterIdentifier(parameter.left);
	}
	return parameter.type === "Identifier" ? parameter : null;
}

function parameterAnnotation(
	parameter: Parameter,
): ESTree.TSTypeAnnotation | null | undefined {
	if (parameter.type === "TSParameterProperty") {
		return parameterAnnotation(parameter.parameter);
	}
	if (parameter.type === "RestElement") {
		return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
	}
	return parameter.typeAnnotation;
}

function isOptionalParameter(parameter: Parameter): boolean {
	return Object.getOwnPropertyDescriptor(parameter, "optional")?.value === true;
}

function unparenthesizedType(type: ESTree.TSType): ESTree.TSType {
	return type.type === "TSParenthesizedType"
		? unparenthesizedType(type.typeAnnotation)
		: type;
}

function atomicTypeFingerprint(type: ESTree.TSType): string {
	const normalizedType = unparenthesizedType(type);
	return (
		JSON.stringify(normalizedType, (key, value) => {
			if (typeof value === "bigint") return `${value}n`;
			if (
				key === "parent" ||
				key === "range" ||
				key === "start" ||
				key === "end" ||
				key === "loc" ||
				key === "raw"
			) {
				return undefined;
			}
			return value;
		}) ?? ""
	);
}

function unionMemberFingerprints(type: ESTree.TSType): string[] {
	const normalizedType = unparenthesizedType(type);
	return normalizedType.type === "TSUnionType"
		? normalizedType.types.flatMap(unionMemberFingerprints)
		: [atomicTypeFingerprint(normalizedType)];
}

function unionFingerprint(members: readonly string[]): string {
	return `union:${[...new Set(members)].sort().join("|")}`;
}

function typeFingerprint(type: ESTree.TSType): string {
	const members = unionMemberFingerprints(type);
	return members.length === 1 ? members[0] : unionFingerprint(members);
}

function optionalTypeFingerprint(type: ESTree.TSType): string {
	return unionFingerprint([
		...unionMemberFingerprints(type),
		'{"type":"TSUndefinedKeyword"}',
	]);
}

function isNarrowingTypeGuard(node: RuntimeFunction): boolean {
	const predicate = node.returnType?.typeAnnotation;
	if (
		predicate?.type !== "TSTypePredicate" ||
		predicate.typeAnnotation === null
	) {
		return false;
	}
	const predicateParameter = predicate.parameterName;
	if (predicateParameter.type === "TSThisType") return true;

	const parameter = node.params.find(
		(candidate) =>
			parameterIdentifier(candidate)?.name === predicateParameter.name,
	);
	if (parameter === undefined) return false;

	const annotation = parameterAnnotation(parameter);
	if (annotation === null || annotation === undefined) return true;

	// Oxlint JS plugins do not expose TypeScript assignability here. Reject
	// syntactically equivalent types, including reordered unions and the
	// implicit `undefined` carried by optional parameters.
	return (
		(isOptionalParameter(parameter)
			? optionalTypeFingerprint(annotation.typeAnnotation)
			: typeFingerprint(annotation.typeAnnotation)) !==
		typeFingerprint(predicate.typeAnnotation.typeAnnotation)
	);
}

function isInsideNarrowingTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return isNarrowingTypeGuard(current);
		}
		current = current.parent;
	}
	return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				if (
					node.operator === "typeof" &&
					(!allowInTypeGuards || !isInsideNarrowingTypeGuard(node))
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});
