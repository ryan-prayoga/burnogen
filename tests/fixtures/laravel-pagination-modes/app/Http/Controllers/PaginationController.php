<?php

namespace App\Http\Controllers;

use App\Http\Resources\ProjectResource;

class PaginationController
{
    public function simple()
    {
        $page = request()->query('page');

        return ProjectResource::collection(
            Project::query()->simplePaginate(10, ['*'], 'page', $page)
        );
    }

    public function cursor()
    {
        $cursor = request()->query('cursor');

        return ProjectResource::collection(
            Project::query()->cursorPaginate(5, ['*'], 'cursor', $cursor)
        );
    }
}
