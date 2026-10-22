import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BanRiskNotice } from "./BanRiskNotice";

describe("BanRiskNotice", () => {
  it("warns about unofficial WhatsApp ban risk", () => {
    render(<BanRiskNotice />);
    expect(screen.getByRole("note")).toHaveTextContent(/Ban risk/i);
    expect(screen.getByRole("note")).toHaveTextContent(/unofficial/i);
  });
});
